//! The account flow against a scripted account service on loopback. No test
//! touches the real credential store or the network.

use super::*;
use crate::cloud::google::MemoryStore;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex as StdMutex};

/// One request as the server saw it.
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    path: String,
    auth: Option<String>,
    form: HashMap<String, String>,
}

type Script = Arc<StdMutex<HashMap<String, VecDeque<(u16, String)>>>>;

/// An account service that answers each `METHOD path` from its own queue of
/// replies, and records what it was sent. Unscripted requests get a 404.
struct Server {
    base: String,
    script: Script,
    seen: Arc<StdMutex<Vec<Seen>>>,
}

impl Server {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let script: Script = Arc::default();
        let seen: Arc<StdMutex<Vec<Seen>>> = Arc::default();
        let (s, v) = (script.clone(), seen.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let request = read_request(&mut stream);
                let key = format!("{} {}", request.method, request.path);
                v.lock().unwrap().push(request);
                let (status, body) = s
                    .lock()
                    .unwrap()
                    .get_mut(&key)
                    .and_then(VecDeque::pop_front)
                    .unwrap_or((404, r#"{"title":"not scripted"}"#.into()));
                let reply = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        Self { base, script, seen }
    }

    fn reply(&self, key: &str, status: u16, body: serde_json::Value) -> &Self {
        self.script
            .lock()
            .unwrap()
            .entry(key.into())
            .or_default()
            .push_back((status, body.to_string()));
        self
    }

    fn seen(&self, key: &str) -> Vec<Seen> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|s| format!("{} {}", s.method, s.path) == key)
            .cloned()
            .collect()
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> Seen {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = stream.read(&mut chunk).unwrap_or(0);
        buf.extend_from_slice(&chunk[..n]);
        let text = String::from_utf8_lossy(&buf).to_string();
        if let Some(split) = text.find("\r\n\r\n") {
            let length = text[..split]
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if buf.len() >= split + 4 + length || n == 0 {
                let head = &text[..split];
                let mut first = head.lines().next().unwrap_or("").split_whitespace();
                let method = first.next().unwrap_or("").to_string();
                let path = first.next().unwrap_or("").to_string();
                let auth = head.lines().find_map(|l| {
                    l.strip_prefix("authorization: ")
                        .or_else(|| l.strip_prefix("Authorization: "))
                        .map(str::to_string)
                });
                let form = url::form_urlencoded::parse(&text.as_bytes()[split + 4..])
                    .into_owned()
                    .collect();
                return Seen {
                    method,
                    path,
                    auth,
                    form,
                };
            }
        }
        if n == 0 {
            return Seen {
                method: String::new(),
                path: String::new(),
                auth: None,
                form: HashMap::new(),
            };
        }
    }
}

const CODE: &str = "POST /v1/device/code";
const TOKEN: &str = "POST /v1/oauth/token";
const REVOKE: &str = "POST /v1/oauth/revoke";
const ME: &str = "GET /v1/me";

fn device() -> DeviceInfo {
    DeviceInfo {
        name: "BRADEN-PC".into(),
        os: "Windows".into(),
        app_version: "0.6.2".into(),
    }
}

fn code_reply(expires_in: u64) -> serde_json::Value {
    serde_json::json!({
        "device_code": "secret-device-code",
        "user_code": "KQ74MX",
        "verification_uri": "https://veistra.com/device",
        "verification_uri_complete": "https://veistra.com/device?code=KQ74MX",
        "expires_in": expires_in,
        "interval": 5
    })
}

fn tokens(access: &str, refresh: &str) -> serde_json::Value {
    serde_json::json!({
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": 900,
        "refresh_token": refresh
    })
}

fn me() -> serde_json::Value {
    serde_json::json!({
        "user": {"id": "u1", "email": "b@example.com", "name": "Braden Seaborn"},
        "workspace": {"id": "w1", "name": "Personal workspace", "plan": "beta"}
    })
}

fn no_sleep(_: Duration) {}

/// An account already signed in with refresh token `refresh`.
fn signed_in(server: &Server, refresh: &str) -> Account {
    let store = MemoryStore::default();
    store
        .set(
            STORE_ACCOUNT,
            &serde_json::json!({
                "refresh_token": refresh,
                "api": server.base,
                "name": "Braden Seaborn",
                "email": "b@example.com"
            })
            .to_string(),
        )
        .unwrap();
    Account::new(Box::new(store))
}

fn stored_refresh(account: &Account) -> Option<String> {
    account
        .store
        .get(STORE_ACCOUNT)
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["refresh_token"].as_str().map(str::to_string))
}

#[test]
fn approval_signs_in_and_keeps_the_refresh_token_in_the_store() {
    let server = Server::start();
    server
        .reply(CODE, 200, code_reply(600))
        .reply(
            TOKEN,
            400,
            serde_json::json!({"error": "authorization_pending"}),
        )
        .reply(TOKEN, 200, tokens("access-1", "refresh-1"))
        .reply(ME, 200, me());
    let account = Account::new(Box::<MemoryStore>::default());

    let started = account.start(&server.base, &device()).unwrap();
    assert_eq!(started.waiting.user_code, "KQ74MX");
    assert_eq!(
        started.waiting.verification_uri_complete,
        "https://veistra.com/device?code=KQ74MX"
    );
    assert!(account.status(&server.base).waiting.is_some());

    let user = account.poll(
        &server.base,
        started.generation,
        started.interval,
        &no_sleep,
    );
    assert_eq!(user.unwrap().email, "b@example.com");

    let status = account.status(&server.base);
    assert_eq!(status.user.unwrap().name, "Braden Seaborn");
    assert!(status.waiting.is_none() && status.outcome.is_none());
    assert_eq!(stored_refresh(&account).as_deref(), Some("refresh-1"));

    let asked = &server.seen(CODE)[0].form;
    assert_eq!(asked["client_id"], wire::CLIENT_ID);
    assert_eq!(asked["device_name"], "BRADEN-PC");
    assert_eq!(asked["os"], "Windows");
    let polled = &server.seen(TOKEN)[0].form;
    assert_eq!(polled["grant_type"], wire::DEVICE_GRANT);
    assert_eq!(polled["device_code"], "secret-device-code");
    assert_eq!(server.seen(ME)[0].auth.as_deref(), Some("Bearer access-1"));
}

#[test]
fn polling_waits_the_servers_interval_and_longer_after_slow_down() {
    let server = Server::start();
    server
        .reply(CODE, 200, code_reply(600))
        .reply(
            TOKEN,
            400,
            serde_json::json!({"error": "authorization_pending"}),
        )
        .reply(TOKEN, 400, serde_json::json!({"error": "slow_down"}))
        .reply(TOKEN, 400, serde_json::json!({"error": "access_denied"}));
    let account = Account::new(Box::<MemoryStore>::default());
    let started = account.start(&server.base, &device()).unwrap();

    let slept = StdMutex::new(Vec::new());
    let record = |d: Duration| slept.lock().unwrap().push(d.as_secs());
    account.poll(&server.base, started.generation, started.interval, &record);

    assert_eq!(*slept.lock().unwrap(), vec![5, 5, 10]);
}

#[test]
fn cancel_on_the_approve_screen_ends_the_sign_in_as_denied() {
    let server = Server::start();
    server.reply(CODE, 200, code_reply(600)).reply(
        TOKEN,
        400,
        serde_json::json!({"error": "access_denied"}),
    );
    let account = Account::new(Box::<MemoryStore>::default());
    let started = account.start(&server.base, &device()).unwrap();

    assert!(account
        .poll(
            &server.base,
            started.generation,
            started.interval,
            &no_sleep
        )
        .is_none());
    let status = account.status(&server.base);
    assert_eq!(status.outcome, Some(Outcome::Denied));
    assert!(status.waiting.is_none() && status.user.is_none());

    account.dismiss();
    assert_eq!(account.status(&server.base).outcome, None);
}

#[test]
fn an_expired_code_ends_the_sign_in_as_expired() {
    let server = Server::start();
    server.reply(CODE, 200, code_reply(600)).reply(
        TOKEN,
        400,
        serde_json::json!({"error": "expired_token"}),
    );
    let account = Account::new(Box::<MemoryStore>::default());
    let started = account.start(&server.base, &device()).unwrap();
    account.poll(
        &server.base,
        started.generation,
        started.interval,
        &no_sleep,
    );
    assert_eq!(account.status(&server.base).outcome, Some(Outcome::Expired));
}

#[test]
fn a_code_past_its_lifetime_stops_polling_without_asking_again() {
    let server = Server::start();
    server.reply(CODE, 200, code_reply(0));
    let account = Account::new(Box::<MemoryStore>::default());
    let started = account.start(&server.base, &device()).unwrap();
    account.poll(
        &server.base,
        started.generation,
        started.interval,
        &no_sleep,
    );
    assert_eq!(account.status(&server.base).outcome, Some(Outcome::Expired));
    assert!(server.seen(TOKEN).is_empty());
}

#[test]
fn cancelling_in_the_app_stops_the_poll_and_stores_nothing() {
    let server = Server::start();
    server.reply(CODE, 200, code_reply(600));
    let account = Account::new(Box::<MemoryStore>::default());
    let started = account.start(&server.base, &device()).unwrap();

    account.cancel();
    assert!(account
        .poll(
            &server.base,
            started.generation,
            started.interval,
            &no_sleep
        )
        .is_none());
    assert!(server.seen(TOKEN).is_empty());
    let status = account.status(&server.base);
    assert!(status.waiting.is_none() && status.outcome.is_none() && status.user.is_none());
}

#[test]
fn a_refresh_rotates_the_stored_token_before_using_the_new_access_token() {
    let server = Server::start();
    server
        .reply(TOKEN, 200, tokens("access-2", "refresh-2"))
        .reply(
            "GET /v1/usage?range=7d",
            200,
            serde_json::json!({"ok": true}),
        );
    let account = signed_in(&server, "refresh-1");

    let usage = account.get(&server.base, "v1/usage?range=7d").unwrap();
    assert_eq!(usage["ok"], true);
    assert_eq!(stored_refresh(&account).as_deref(), Some("refresh-2"));

    let refresh = &server.seen(TOKEN)[0].form;
    assert_eq!(refresh["grant_type"], "refresh_token");
    assert_eq!(refresh["refresh_token"], "refresh-1");

    // Cached for its lifetime: a second read does not refresh again.
    server.reply(
        "GET /v1/usage?range=7d",
        200,
        serde_json::json!({"ok": true}),
    );
    account.get(&server.base, "v1/usage?range=7d").unwrap();
    assert_eq!(server.seen(TOKEN).len(), 1);
}

#[test]
fn concurrent_reads_spend_the_refresh_token_once() {
    let server = Server::start();
    server.reply(TOKEN, 200, tokens("access-2", "refresh-2"));
    for _ in 0..4 {
        server.reply(ME, 200, me());
    }
    let account = Arc::new(signed_in(&server, "refresh-1"));
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let (account, base) = (account.clone(), server.base.clone());
            std::thread::spawn(move || account.get(&base, "v1/me").is_ok())
        })
        .collect();
    assert!(threads.into_iter().all(|t| t.join().unwrap()));
    assert_eq!(
        server.seen(TOKEN).len(),
        1,
        "a second refresh would end the family"
    );
}

#[test]
fn invalid_grant_on_refresh_signs_this_computer_out() {
    let server = Server::start();
    server.reply(TOKEN, 400, serde_json::json!({"error": "invalid_grant"}));
    let account = signed_in(&server, "refresh-reused");

    assert_eq!(
        account.get(&server.base, "v1/me"),
        Err(AccountError::SignedOut)
    );
    assert!(account.status(&server.base).user.is_none());
    assert!(stored_refresh(&account).is_none());
}

#[test]
fn a_401_is_retried_once_with_a_fresh_token() {
    let server = Server::start();
    server
        .reply(TOKEN, 200, tokens("access-old", "refresh-2"))
        .reply(TOKEN, 200, tokens("access-new", "refresh-3"))
        .reply(ME, 401, serde_json::json!({"error": "invalid_token"}))
        .reply(ME, 200, me());
    let account = signed_in(&server, "refresh-1");

    assert_eq!(account.get(&server.base, "v1/me").unwrap(), me());
    let auths: Vec<_> = server.seen(ME).into_iter().map(|s| s.auth).collect();
    assert_eq!(
        auths,
        vec![
            Some("Bearer access-old".to_string()),
            Some("Bearer access-new".to_string())
        ]
    );
    assert_eq!(stored_refresh(&account).as_deref(), Some("refresh-3"));
}

#[test]
fn sign_out_revokes_the_refresh_token_and_forgets_it_even_offline() {
    let server = Server::start();
    server.reply(REVOKE, 200, serde_json::json!({}));
    let account = signed_in(&server, "refresh-1");
    account.sign_out(&server.base);
    assert_eq!(server.seen(REVOKE)[0].form["token"], "refresh-1");
    assert!(stored_refresh(&account).is_none());

    let offline = Account::new(Box::<MemoryStore>::default());
    let store_text = serde_json::json!({
        "refresh_token": "r", "api": "http://127.0.0.1:9", "name": "", "email": ""
    });
    offline
        .store
        .set(STORE_ACCOUNT, &store_text.to_string())
        .unwrap();
    offline.sign_out("http://127.0.0.1:9");
    assert!(stored_refresh(&offline).is_none());
}

#[test]
fn a_sign_in_for_another_service_reads_as_signed_out() {
    let server = Server::start();
    let account = signed_in(&server, "refresh-1");
    assert!(account.status(&server.base).user.is_some());
    assert!(account.status("https://elsewhere.example").user.is_none());
}

#[test]
fn no_address_means_not_configured_rather_than_a_network_error() {
    let account = Account::new(Box::<MemoryStore>::default());
    assert!(!account.status("").configured);
    assert_eq!(
        account.start("  ", &device()).err(),
        Some(AccountError::NotConfigured)
    );
    assert_eq!(account.get("", "v1/me"), Err(AccountError::NotConfigured));
}

#[test]
fn no_token_reaches_the_status_or_an_error() {
    let server = Server::start();
    server
        .reply(CODE, 200, code_reply(600))
        .reply(TOKEN, 200, tokens("access-SECRET", "refresh-SECRET"))
        .reply(ME, 200, me())
        .reply(
            "GET /v1/runs",
            500,
            serde_json::json!({"type": "about:blank", "title": "Something broke"}),
        );
    let account = Account::new(Box::<MemoryStore>::default());
    let started = account.start(&server.base, &device()).unwrap();
    account.poll(
        &server.base,
        started.generation,
        started.interval,
        &no_sleep,
    );

    let status = serde_json::to_string(&account.status(&server.base)).unwrap();
    assert!(!status.contains("SECRET") && !status.contains("secret-device-code"));
    let error = account.get(&server.base, "v1/runs").unwrap_err();
    assert_eq!(error.describe(), "Something broke");
    assert!(!error.describe().contains("SECRET"));
}

#[test]
fn problem_details_and_oauth_errors_are_read_apart() {
    assert_eq!(
        wire::failure(400, br#"{"error":"slow_down"}"#),
        Failure::OAuth("slow_down".into())
    );
    assert_eq!(
        wire::failure(402, br#"{"type":"https://veistra.com/problems/limit-reached","title":"Limit reached","detail":"Billed runs are paused."}"#),
        Failure::Status {
            status: 402,
            kind: Some("https://veistra.com/problems/limit-reached".into()),
            message: "Billed runs are paused.".into()
        }
    );
    assert_eq!(wire::failure(401, b"{}"), Failure::Unauthorized);
    assert_eq!(
        wire::url("https://api.example/", "/v1/me"),
        "https://api.example/v1/me"
    );
}

#[test]
fn only_https_or_loopback_addresses_are_opened() {
    use super::methods::safe_to_open;
    assert!(safe_to_open("https://veistra.com/device?code=KQ74MX"));
    assert!(safe_to_open("http://127.0.0.1:8080/device"));
    assert!(!safe_to_open("http://veistra.com/device"));
    assert!(!safe_to_open("file:///C:/Windows/System32/calc.exe"));
    assert!(!safe_to_open("javascript:alert(1)"));
}
