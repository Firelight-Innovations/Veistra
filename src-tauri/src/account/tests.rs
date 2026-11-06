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
    /// The body as sent, for the JSON writes.
    body: String,
}

/// Each reply: its status, its `Content-Type` and its body.
type Script = Arc<StdMutex<HashMap<String, VecDeque<(u16, String, Vec<u8>)>>>>;

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
                let (status, kind, body) = s
                    .lock()
                    .unwrap()
                    .get_mut(&key)
                    .and_then(VecDeque::pop_front)
                    .unwrap_or_else(|| {
                        let body = br#"{"title":"not scripted"}"#.to_vec();
                        (404, "application/json".into(), body)
                    });
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&body);
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
            .push_back((
                status,
                "application/json".into(),
                body.to_string().into_bytes(),
            ));
        self
    }

    /// A reply that is not JSON: a picture's bytes, with their type.
    fn reply_raw(&self, key: &str, status: u16, kind: &str, body: &[u8]) -> &Self {
        self.script
            .lock()
            .unwrap()
            .entry(key.into())
            .or_default()
            .push_back((status, kind.into(), body.to_vec()));
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
                let raw = &text.as_bytes()[split + 4..];
                let form = url::form_urlencoded::parse(raw).into_owned().collect();
                return Seen {
                    method,
                    path,
                    auth,
                    form,
                    body: String::from_utf8_lossy(raw).into_owned(),
                };
            }
        }
        if n == 0 {
            return Seen {
                method: String::new(),
                path: String::new(),
                auth: None,
                form: HashMap::new(),
                body: String::new(),
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
fn a_server_error_or_a_429_while_polling_is_not_an_answer() {
    // The service leaves an approved code approved when it fails, so the
    // next poll collects the tokens (`docs/account-api.md`, the poll table).
    let server = Server::start();
    server
        .reply(CODE, 200, code_reply(600))
        .reply(
            TOKEN,
            503,
            serde_json::json!({"title": "Something went wrong on our side."}),
        )
        .reply(
            TOKEN,
            429,
            serde_json::json!({"title": "Too many requests."}),
        )
        .reply(TOKEN, 502, serde_json::json!({}))
        .reply(TOKEN, 200, tokens("access-1", "refresh-1"))
        .reply(ME, 200, me());
    let account = Account::new(Box::<MemoryStore>::default());
    let started = account.start(&server.base, &device()).unwrap();

    let user = account.poll(
        &server.base,
        started.generation,
        started.interval,
        &no_sleep,
    );
    assert_eq!(user.unwrap().email, "b@example.com");
    assert_eq!(server.seen(TOKEN).len(), 4);
    assert_eq!(stored_refresh(&account).as_deref(), Some("refresh-1"));
}

#[test]
fn a_4xx_problem_while_polling_ends_the_sign_in_in_words() {
    let server = Server::start();
    server.reply(CODE, 200, code_reply(600)).reply(
        TOKEN,
        400,
        serde_json::json!({"title": "Send a form.", "detail": "The body was not a form."}),
    );
    let account = Account::new(Box::<MemoryStore>::default());
    let started = account.start(&server.base, &device()).unwrap();
    account.poll(
        &server.base,
        started.generation,
        started.interval,
        &no_sleep,
    );
    assert_eq!(
        account.status(&server.base).outcome,
        Some(Outcome::Failed("The body was not a form.".into()))
    );
}

#[test]
fn an_unreachable_service_says_so_in_plain_words() {
    // Port 9 (discard) is closed on loopback: the connection is refused.
    let account = Account::new(Box::<MemoryStore>::default());
    let error = account.start("http://127.0.0.1:9", &device()).unwrap_err();
    assert_eq!(error.reason(), "unreachable");
    assert!(
        error
            .describe()
            .starts_with("Could not reach the Veistra account service."),
        "{}",
        error.describe()
    );
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
fn a_refresh_over_its_limit_keeps_the_token_and_says_to_wait() {
    // `429` with `Retry-After: 60`: the stored token is still good, so this
    // computer stays signed in and the next read tries again.
    let server = Server::start();
    server
        .reply(
            TOKEN,
            429,
            serde_json::json!({
                "type": "https://veistra.com/problems/rate-limited",
                "title": "Too many requests. Wait a minute, then try again.",
                "status": 429
            }),
        )
        .reply(TOKEN, 200, tokens("access-1", "refresh-2"))
        .reply(ME, 200, me());
    let account = signed_in(&server, "refresh-1");

    let error = account.get(&server.base, "v1/me").unwrap_err();
    assert_eq!(error.reason(), "failed");
    assert_eq!(
        error.describe(),
        "Too many requests. Wait a minute, then try again."
    );
    assert_eq!(stored_refresh(&account).as_deref(), Some("refresh-1"));
    assert!(account.status(&server.base).user.is_some());

    assert_eq!(account.get(&server.base, "v1/me").unwrap(), me());
    assert_eq!(server.seen(TOKEN)[1].form["refresh_token"], "refresh-1");
    assert_eq!(stored_refresh(&account).as_deref(), Some("refresh-2"));
}

#[test]
fn a_server_error_on_refresh_keeps_this_computer_signed_in() {
    let server = Server::start();
    server.reply(
        TOKEN,
        500,
        serde_json::json!({"title": "Something went wrong on our side."}),
    );
    let account = signed_in(&server, "refresh-1");
    let error = account
        .get(&server.base, "v1/usage?range=period")
        .unwrap_err();
    assert_eq!(error.describe(), "Something went wrong on our side.");
    assert_eq!(stored_refresh(&account).as_deref(), Some("refresh-1"));
}

#[test]
fn usage_and_runs_are_read_with_the_bearer_token_and_passed_through_whole() {
    // The contract's own example, with the alert email off: the frontend
    // reads `alert_pct: null`, so nothing here may turn it into a number.
    let usage = serde_json::json!({
        "range": {"from": "2026-11-01", "to": "2026-11-04"},
        "period": {"from": "2026-11-01", "to": "2026-11-30", "resets": "2026-12-01"},
        "totals": {
            "cost_micros": 0,
            "by_source": {},
            "unbilled_runs": {"own_claude": 3, "own_codex": 1}
        },
        "daily": [],
        "projects": ["Anomaly"],
        "limit": {
            "monthly_limit_micros": 50_000_000,
            "spent_this_period_micros": 0,
            "alert_pct": null,
            "pause_at_limit": true,
            "projected_date": null
        },
        "synced_at": "2026-11-04T18:00:00.000Z"
    });
    let runs = serde_json::json!({
        "runs": [{
            "id": "3b2f8c1e-6a4d-4e8b-9c1f-2d3e4f5a6b7c", "name": "Fix the crate",
            "project": "Anomaly", "harness": "claude_code", "status": "finished",
            "started_at": "2026-11-04T17:20:00.000Z", "tokens": null,
            "cost_micros": null, "billed": false
        }],
        "next_cursor": null
    });
    let server = Server::start();
    server
        .reply(TOKEN, 200, tokens("access-1", "refresh-2"))
        .reply("GET /v1/usage?range=7d&project=Anomaly", 200, usage.clone())
        .reply("GET /v1/runs?limit=50", 200, runs.clone());
    let account = signed_in(&server, "refresh-1");

    assert_eq!(
        account
            .get(&server.base, "v1/usage?range=7d&project=Anomaly")
            .unwrap(),
        usage
    );
    assert_eq!(account.get(&server.base, "v1/runs?limit=50").unwrap(), runs);
    let seen = server.seen("GET /v1/runs?limit=50");
    assert_eq!(seen[0].auth.as_deref(), Some("Bearer access-1"));
    // One refresh served both reads.
    assert_eq!(server.seen(TOKEN).len(), 1);
}

#[test]
fn the_shipped_defaults_are_the_live_service_and_its_site() {
    use crate::settings::{DEFAULT_ACCOUNT_API, DEFAULT_ACCOUNT_WEB};
    // Called directly, never through Hosting, and everything before `/v1`.
    assert!(
        DEFAULT_ACCOUNT_API.starts_with("https://") && DEFAULT_ACCOUNT_API.ends_with(".run.app")
    );
    assert_eq!(
        wire::url(DEFAULT_ACCOUNT_API, "v1/me"),
        format!("{DEFAULT_ACCOUNT_API}/v1/me")
    );
    // The approve page the service sends and the pages the app opens are one
    // site, so the browser's session cookie covers both.
    assert!(DEFAULT_ACCOUNT_WEB.starts_with("https://") && !DEFAULT_ACCOUNT_WEB.ends_with('/'));
    assert!(super::methods::safe_to_open(&format!(
        "{DEFAULT_ACCOUNT_WEB}/device"
    )));
    assert!(
        Account::new(Box::<MemoryStore>::default())
            .status(DEFAULT_ACCOUNT_API)
            .configured
    );
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

// --- Claude Code and Codex sessions as runs (`runs.rs`) ----------------------

mod runs {
    use super::*;
    use crate::account::runs::{send, Op, Runs};
    use veistra_agent_host::{Harness, SessionState as S};

    const CWD: &str = r"C:\work\Anomaly";

    fn started(ops: &[Op]) -> String {
        match ops {
            [Op::Start { id, .. }] => id.clone(),
            other => panic!("expected one start, got {other:?}"),
        }
    }

    #[test]
    fn one_session_is_one_run_from_start_to_stop() {
        let runs = Runs::default();
        let ops = runs.observe("tab-1", S::Starting, Harness::Claude, CWD, true);
        let id = started(&ops);
        assert_eq!(
            ops[0],
            Op::Start {
                id: id.clone(),
                harness: "claude_code",
                name: "Claude Code session".into(),
                project: "Anomaly".into(),
            }
        );
        // A UUID, as the service requires: it makes a retried POST one run.
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        // Turns come and go inside the one session.
        for state in [S::Ready, S::Working, S::NeedsInput, S::Working, S::Ready] {
            assert!(runs
                .observe("tab-1", state, Harness::Claude, CWD, true)
                .is_empty());
        }
        assert_eq!(
            runs.observe("tab-1", S::Stopped, Harness::Claude, CWD, true),
            vec![Op::Finish { id, failed: false }]
        );
        // The next session is the next run.
        started(&runs.observe("tab-1", S::Starting, Harness::Claude, CWD, true));
    }

    #[test]
    fn a_failed_session_finishes_its_run_as_failed() {
        let runs = Runs::default();
        let id = started(&runs.observe(
            "t",
            S::Starting,
            Harness::Codex,
            "/home/b/Torn Apart/",
            true,
        ));
        assert_eq!(
            runs.observe("t", S::Failed, Harness::Codex, "", true),
            vec![Op::Finish { id, failed: true }]
        );
        // A session that never started is no run.
        assert!(runs
            .observe("u", S::Failed, Harness::Codex, "", true)
            .is_empty());
    }

    #[test]
    fn a_harness_switch_ends_the_old_run_and_ignores_its_late_stop() {
        let runs = Runs::default();
        let claude = started(&runs.observe("t", S::Starting, Harness::Claude, CWD, true));
        let ops = runs.observe("t", S::Starting, Harness::Codex, CWD, true);
        assert_eq!(
            ops[0],
            Op::Finish {
                id: claude,
                failed: false
            }
        );
        assert!(matches!(
            &ops[1],
            Op::Start {
                harness: "codex",
                ..
            }
        ));
        // The retired Claude process reports its exit after the switch.
        assert!(runs
            .observe("t", S::Stopped, Harness::Claude, CWD, true)
            .is_empty());
    }

    #[test]
    fn veistra_sessions_are_metered_by_the_service_not_reported() {
        let runs = Runs::default();
        assert!(runs
            .observe("t", S::Starting, Harness::Veistra, CWD, true)
            .is_empty());
        assert!(runs
            .observe("t", S::Stopped, Harness::Veistra, CWD, true)
            .is_empty());
    }

    #[test]
    fn turned_off_starts_nothing_but_still_finishes_an_open_run() {
        let runs = Runs::default();
        assert!(runs
            .observe("t", S::Starting, Harness::Claude, CWD, false)
            .is_empty());
        let id = started(&runs.observe("u", S::Starting, Harness::Claude, CWD, true));
        assert_eq!(
            runs.observe("u", S::Stopped, Harness::Claude, CWD, false),
            vec![Op::Finish { id, failed: false }]
        );
    }

    #[test]
    fn a_run_is_sent_as_the_service_takes_it() {
        let server = Server::start();
        let id = "3b2f8c1e-6a4d-4e8b-9c1f-2d3e4f5a6b7c";
        let patch = format!("PATCH /v1/runs/{id}");
        server
            .reply(TOKEN, 200, tokens("access-1", "refresh-2"))
            .reply("POST /v1/runs", 201, serde_json::json!({ "id": id }))
            .reply(&patch, 200, serde_json::json!({ "id": id }));
        let account = signed_in(&server, "refresh-1");

        let start = Op::Start {
            id: id.into(),
            harness: "claude_code",
            name: "Claude Code session".into(),
            project: "Anomaly".into(),
        };
        send(&account, &server.base, &start).unwrap();
        let posted = &server.seen("POST /v1/runs")[0];
        assert_eq!(posted.auth.as_deref(), Some("Bearer access-1"));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&posted.body).unwrap(),
            serde_json::json!({
                "id": id, "harness": "claude_code",
                "name": "Claude Code session", "project": "Anomaly"
            })
        );

        send(
            &account,
            &server.base,
            &Op::Finish {
                id: id.into(),
                failed: true,
            },
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&server.seen(&patch)[0].body).unwrap(),
            serde_json::json!({ "status": "failed", "tokens": null })
        );
    }

    #[test]
    fn signed_out_nothing_leaves_this_computer() {
        let server = Server::start();
        let account = Account::new(Box::<MemoryStore>::default());
        let op = Op::Finish {
            id: "x".into(),
            failed: false,
        };
        assert_eq!(
            send(&account, &server.base, &op),
            Err(AccountError::SignedOut)
        );
        assert_eq!(send(&account, "", &op), Err(AccountError::NotConfigured));
        assert!(server.seen("PATCH /v1/runs/x").is_empty());
        assert!(server.seen(TOKEN).is_empty());
    }
}

// --- The profile picture ------------------------------------------------------

mod picture {
    use super::*;

    const PNG: &[u8] = &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];

    #[test]
    fn reads_the_picture_as_a_data_url_the_shell_can_draw() {
        let server = Server::start();
        server
            .reply(TOKEN, 200, tokens("access-1", "refresh-2"))
            .reply_raw("GET /v1/me/avatar", 200, "image/png", PNG);
        let account = signed_in(&server, "refresh-1");
        let url = account.picture(&server.base).unwrap();
        assert_eq!(
            url,
            serde_json::json!("data:image/png;base64,iVBORw0KGgoBAgM=")
        );
        let seen = &server.seen("GET /v1/me/avatar")[0];
        assert_eq!(seen.auth.as_deref(), Some("Bearer access-1"));
    }

    #[test]
    fn none_set_is_null_and_anything_but_a_picture_is_refused() {
        let server = Server::start();
        server
            .reply(TOKEN, 200, tokens("access-1", "refresh-2"))
            .reply(
                "GET /v1/me/avatar",
                404,
                serde_json::json!({ "type": "https://veistra.com/problems/no-avatar" }),
            )
            .reply_raw("GET /v1/me/avatar", 200, "text/html", b"<script></script>");
        let account = signed_in(&server, "refresh-1");
        assert_eq!(account.picture(&server.base), Ok(Value::Null));
        let refused = account.picture(&server.base).unwrap_err();
        assert!(refused.describe().contains("cannot show"), "{refused:?}");
    }

    #[test]
    fn sets_it_as_json_and_removes_it_with_a_bare_delete() {
        let server = Server::start();
        server
            .reply(TOKEN, 200, tokens("access-1", "refresh-2"))
            .reply(
                "PUT /v1/me/avatar",
                200,
                serde_json::json!({ "avatar": "3f9a2c41d0e8b7a6" }),
            )
            .reply_raw("DELETE /v1/me/avatar", 204, "application/json", b"");
        let account = signed_in(&server, "refresh-1");
        let body = serde_json::json!({ "image": "UklGRg==" });
        let set = account
            .write(&server.base, "PUT", "v1/me/avatar", &body)
            .unwrap();
        assert_eq!(set, serde_json::json!({ "avatar": "3f9a2c41d0e8b7a6" }));
        let put = &server.seen("PUT /v1/me/avatar")[0];
        assert_eq!(put.auth.as_deref(), Some("Bearer access-1"));
        assert_eq!(serde_json::from_str::<Value>(&put.body).unwrap(), body);

        let gone = account.write(&server.base, "DELETE", "v1/me/avatar", &Value::Null);
        assert_eq!(gone, Ok(Value::Null));
        let delete = &server.seen("DELETE /v1/me/avatar")[0];
        assert_eq!(delete.auth.as_deref(), Some("Bearer access-1"));
        assert_eq!(delete.body, "");
    }

    #[test]
    fn signed_out_asks_for_nothing() {
        let server = Server::start();
        let account = Account::new(Box::<MemoryStore>::default());
        assert_eq!(account.picture(&server.base), Err(AccountError::SignedOut));
        assert!(server.seen("GET /v1/me/avatar").is_empty());
    }
}
