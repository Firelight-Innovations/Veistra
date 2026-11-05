//! The Veistra account on this computer: signing in through the browser, and
//! the tokens that keep the app signed in afterwards.
//!
//! Sign-in is the OAuth 2.0 Device Authorization Grant (RFC 8628). The app asks
//! for a code, shows it, opens veistra.com/device, and polls the token endpoint
//! until the person approves in the browser. `docs/account-api.md` lists every
//! request this module sends.
//!
//! Where each credential lives:
//!
//! - **Refresh token**: the OS credential store (Windows Credential Manager),
//!   through the same [`SecretStore`] the Google sign-in uses. The server
//!   rotates it on every use, so the stored one is replaced every refresh.
//! - **Access token**: memory only, for its 15 minutes.
//! - **Device code**: memory only, for the 10 minutes a sign-in can wait.
//!
//! No token reaches the frontend, a log line or an error message: the frontend
//! sees [`Status`], which has a name and an email and nothing else.

pub mod methods;
pub mod wire;

use crate::cloud::google::SecretStore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use wire::Failure;

/// The credential-store entry, under the app's keyring service.
const STORE_ACCOUNT: &str = "veistra-account";

/// Refresh this long before the access token's own expiry, so a request does
/// not leave with a token that dies on the way.
const EARLY: Duration = Duration::from_secs(60);

/// RFC 8628 §3.5: the poll interval when the server names none, and how much
/// longer to wait after `slow_down`.
const DEFAULT_INTERVAL: Duration = Duration::from_secs(5);
const SLOW_DOWN: Duration = Duration::from_secs(5);

/// What the app sends about itself, for the approve screen to show.
#[derive(Debug, Clone)]
pub struct DeviceInfo {
    pub name: String,
    pub os: String,
    pub app_version: String,
}

impl DeviceInfo {
    /// This computer, as Windows names it.
    pub fn this_computer() -> Self {
        let name = ["COMPUTERNAME", "HOSTNAME"]
            .iter()
            .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
            .unwrap_or_else(|| "This computer".into());
        let os = match std::env::consts::OS {
            "windows" => "Windows",
            "macos" => "macOS",
            "linux" => "Linux",
            other => other,
        };
        Self {
            name,
            os: os.into(),
            app_version: env!("CARGO_PKG_VERSION").into(),
        }
    }
}

/// What is kept in the credential store. `api` is kept so that pointing the
/// app at another service reads as signed out rather than as a refresh failure.
#[derive(Serialize, Deserialize)]
struct Stored {
    refresh_token: String,
    api: String,
    name: String,
    email: String,
}

/// The signed-in person, as the status bar and the account panel name them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct User {
    pub name: String,
    pub email: String,
}

/// A sign-in waiting for the browser. Everything here is safe to show: the
/// user code is what the person compares on the approve screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Waiting {
    pub user_code: String,
    pub verification_uri: String,
    /// The approve page with the code filled in, for Copy sign-in link.
    pub verification_uri_complete: String,
    /// Milliseconds since the Unix epoch, for the frontend's countdown.
    pub expires_at_ms: u64,
}

/// A sign-in that has its code: what to show, and what the poll loop needs.
#[derive(Debug, Clone)]
pub struct Started {
    pub waiting: Waiting,
    pub generation: u64,
    /// The server's poll interval, when it named one.
    pub interval: Option<Duration>,
}

/// How the last sign-in ended, when it did not end signed in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind", content = "detail")]
pub enum Outcome {
    /// The person chose Cancel on the approve screen (`access_denied`).
    Denied,
    /// Ten minutes passed without an answer (`expired_token`).
    Expired,
    /// Anything else, in words.
    Failed(String),
}

/// What the frontend draws. No token in here, by construction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The account service's address is set.
    pub configured: bool,
    pub user: Option<User>,
    pub waiting: Option<Waiting>,
    pub outcome: Option<Outcome>,
}

/// Why an authenticated request could not be made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AccountError {
    /// No account service address is set.
    NotConfigured,
    /// Nobody is signed in, or the server ended this computer's sign-in.
    SignedOut,
    Failed(Failure),
}

impl AccountError {
    /// A short, stable code the frontend branches on.
    pub fn reason(&self) -> &'static str {
        match self {
            AccountError::NotConfigured => "not-configured",
            AccountError::SignedOut => "signed-out",
            AccountError::Failed(Failure::Unreachable(_)) => "unreachable",
            AccountError::Failed(_) => "failed",
        }
    }

    pub fn describe(&self) -> String {
        match self {
            AccountError::NotConfigured => "Veistra accounts are off in this build: the account \
                 service address is empty (Settings, Developer, Account service)."
                .into(),
            AccountError::SignedOut => "This computer is not signed in to Veistra.".into(),
            AccountError::Failed(failure) => failure.describe(),
        }
    }
}

#[derive(Default)]
struct SignIn {
    /// Bumped by every start and every cancel. A poll loop that sees a
    /// different number from the one it started with stops.
    generation: u64,
    waiting: Option<(Waiting, String)>,
    outcome: Option<Outcome>,
}

pub struct Account {
    store: Box<dyn SecretStore>,
    access: Mutex<Option<(String, Instant)>>,
    /// Held across a refresh. Two refreshes with one refresh token would look
    /// to the server like a copied token, and it would end this device's whole
    /// token family (`docs/account-api.md`, Refreshing).
    refreshing: Mutex<()>,
    sign_in: Mutex<SignIn>,
}

impl Default for Account {
    fn default() -> Self {
        Self::new(Box::new(crate::cloud::google::KeyringStore))
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Account {
    pub fn new(store: Box<dyn SecretStore>) -> Self {
        Self {
            store,
            access: Mutex::new(None),
            refreshing: Mutex::new(()),
            sign_in: Mutex::new(SignIn::default()),
        }
    }

    fn stored(&self, api: &str) -> Option<Stored> {
        let text = self.store.get(STORE_ACCOUNT)?;
        let stored: Stored = serde_json::from_str(&text).ok()?;
        (stored.api == api.trim()).then_some(stored)
    }

    fn save(&self, stored: &Stored) -> Result<(), AccountError> {
        let text = serde_json::to_string(stored)
            .map_err(|e| AccountError::Failed(Failure::Unreachable(e.to_string())))?;
        self.store.set(STORE_ACCOUNT, &text).map_err(|e| {
            AccountError::Failed(Failure::Status {
                status: 0,
                kind: None,
                message: e,
            })
        })
    }

    /// Forget everything local: the stored token and the one in memory.
    fn forget(&self) {
        let _ = self.store.delete(STORE_ACCOUNT);
        *lock(&self.access) = None;
    }

    /// No network: who is signed in and whether a sign-in is waiting.
    pub fn status(&self, api: &str) -> Status {
        let sign_in = lock(&self.sign_in);
        Status {
            configured: !api.trim().is_empty(),
            user: self.stored(api).map(|s| User {
                name: s.name,
                email: s.email,
            }),
            waiting: sign_in.waiting.as_ref().map(|(w, _)| w.clone()),
            outcome: sign_in.outcome.clone(),
        }
    }

    // --- signing in ----------------------------------------------------------

    /// Ask for a code. Answers what the sign-in screen shows, and what
    /// [`poll`](Self::poll) must be handed.
    pub fn start(&self, api: &str, device: &DeviceInfo) -> Result<Started, AccountError> {
        if api.trim().is_empty() {
            return Err(AccountError::NotConfigured);
        }
        let reply = wire::post_form(
            &wire::url(api, "v1/device/code"),
            &[
                ("client_id", wire::CLIENT_ID),
                ("device_name", &device.name),
                ("os", &device.os),
                ("app_version", &device.app_version),
            ],
        )
        .map_err(AccountError::Failed)?;
        let code: wire::DeviceCode = serde_json::from_value(reply).map_err(|_| {
            AccountError::Failed(Failure::Status {
                status: 200,
                kind: None,
                message: "The sign-in code reply could not be read.".into(),
            })
        })?;
        let waiting = Waiting {
            verification_uri_complete: code
                .verification_uri_complete
                .clone()
                .unwrap_or_else(|| code.verification_uri.clone()),
            user_code: code.user_code,
            verification_uri: code.verification_uri,
            expires_at_ms: now_ms() + code.expires_in * 1000,
        };
        let mut sign_in = lock(&self.sign_in);
        sign_in.generation += 1;
        sign_in.outcome = None;
        sign_in.waiting = Some((waiting.clone(), code.device_code));
        Ok(Started {
            waiting,
            generation: sign_in.generation,
            interval: code.interval.map(Duration::from_secs),
        })
    }

    /// Stop a sign-in that is waiting. The poll loop notices on its next turn.
    pub fn cancel(&self) {
        let mut sign_in = lock(&self.sign_in);
        sign_in.generation += 1;
        sign_in.waiting = None;
        sign_in.outcome = None;
    }

    /// Forget how the last sign-in ended, so the start screen draws again.
    pub fn dismiss(&self) {
        lock(&self.sign_in).outcome = None;
    }

    /// The device code and expiry for `generation`, or `None` once cancelled.
    fn pending(&self, generation: u64) -> Option<(String, u64)> {
        let sign_in = lock(&self.sign_in);
        if sign_in.generation != generation {
            return None;
        }
        sign_in
            .waiting
            .as_ref()
            .map(|(w, code)| (code.clone(), w.expires_at_ms))
    }

    /// End the sign-in `generation`, unless a newer one has replaced it.
    fn finish(&self, generation: u64, outcome: Option<Outcome>) {
        let mut sign_in = lock(&self.sign_in);
        if sign_in.generation == generation {
            sign_in.waiting = None;
            sign_in.outcome = outcome;
        }
    }

    /// Poll the token endpoint until the browser answers (RFC 8628 §3.4–3.5).
    /// `interval` is the server's, and `sleep` is `std::thread::sleep` outside
    /// tests. Answers the signed-in person, or `None` if cancelled.
    pub fn poll(
        &self,
        api: &str,
        generation: u64,
        interval: Option<Duration>,
        sleep: &dyn Fn(Duration),
    ) -> Option<User> {
        let mut interval = interval.unwrap_or(DEFAULT_INTERVAL);
        loop {
            sleep(interval);
            let (device_code, expires_at_ms) = self.pending(generation)?;
            if now_ms() >= expires_at_ms {
                self.finish(generation, Some(Outcome::Expired));
                return None;
            }
            let reply = wire::post_form(
                &wire::url(api, "v1/oauth/token"),
                &[
                    ("grant_type", wire::DEVICE_GRANT),
                    ("device_code", &device_code),
                    ("client_id", wire::CLIENT_ID),
                ],
            );
            let outcome = match reply {
                Ok(value) => match self.accept(api, generation, value) {
                    Ok(user) => return user,
                    Err(e) => Outcome::Failed(e.describe()),
                },
                Err(Failure::OAuth(code)) => match code.as_str() {
                    "authorization_pending" => continue,
                    "slow_down" => {
                        interval += SLOW_DOWN;
                        continue;
                    }
                    "access_denied" => Outcome::Denied,
                    "expired_token" => Outcome::Expired,
                    _ => Outcome::Failed(Failure::OAuth(code).describe()),
                },
                // A dropped connection is not an answer; the code is still
                // good until it expires, so keep asking.
                Err(Failure::Unreachable(_)) => continue,
                // Nor is the service failing, or Cloud Run's own front end
                // refusing one request: an approved code stays approved, and a
                // later poll collects its tokens. The expiry check above ends it.
                Err(Failure::Status { status, .. }) if status >= 500 || status == 429 => continue,
                Err(other) => Outcome::Failed(other.describe()),
            };
            self.finish(generation, Some(outcome));
            return None;
        }
    }

    /// Tokens arrived: ask who they belong to, then keep them. Nothing is
    /// stored if the sign-in was cancelled while the reply was in flight.
    fn accept(
        &self,
        api: &str,
        generation: u64,
        value: Value,
    ) -> Result<Option<User>, AccountError> {
        let tokens: wire::Tokens = serde_json::from_value(value).map_err(|_| {
            AccountError::Failed(Failure::Status {
                status: 200,
                kind: None,
                message: "The token reply could not be read.".into(),
            })
        })?;
        let refresh_token = tokens.refresh_token.ok_or_else(|| {
            AccountError::Failed(Failure::Status {
                status: 200,
                kind: None,
                message: "The account service sent no refresh token.".into(),
            })
        })?;
        let me = wire::get(&wire::url(api, "v1/me"), &tokens.access_token)
            .map_err(AccountError::Failed)?;
        let user = User {
            name: me["user"]["name"].as_str().unwrap_or_default().to_string(),
            email: me["user"]["email"].as_str().unwrap_or_default().to_string(),
        };
        if self.pending(generation).is_none() {
            return Ok(None);
        }
        self.save(&Stored {
            refresh_token,
            api: api.trim().to_string(),
            name: user.name.clone(),
            email: user.email.clone(),
        })?;
        self.keep(tokens.access_token, tokens.expires_in);
        self.finish(generation, None);
        Ok(Some(user))
    }

    fn keep(&self, token: String, expires_in: Option<u64>) {
        let lifetime = Duration::from_secs(expires_in.unwrap_or(900)).saturating_sub(EARLY);
        *lock(&self.access) = Some((token, Instant::now() + lifetime));
    }

    // --- staying signed in -----------------------------------------------------

    fn cached(&self) -> Option<String> {
        lock(&self.access)
            .as_ref()
            .filter(|(_, until)| Instant::now() < *until)
            .map(|(token, _)| token.clone())
    }

    /// An access token, refreshed when it is near expiry. The new refresh
    /// token is written to the store before the access token is used.
    pub fn access_token(&self, api: &str) -> Result<String, AccountError> {
        if api.trim().is_empty() {
            return Err(AccountError::NotConfigured);
        }
        if let Some(token) = self.cached() {
            return Ok(token);
        }
        let _one_at_a_time = lock(&self.refreshing);
        // Another caller may have refreshed while this one waited.
        if let Some(token) = self.cached() {
            return Ok(token);
        }
        let stored = self.stored(api).ok_or(AccountError::SignedOut)?;
        let reply = wire::post_form(
            &wire::url(api, "v1/oauth/token"),
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &stored.refresh_token),
                ("client_id", wire::CLIENT_ID),
            ],
        );
        let tokens: wire::Tokens = match reply {
            Ok(value) => serde_json::from_value(value).map_err(|_| {
                AccountError::Failed(Failure::Status {
                    status: 200,
                    kind: None,
                    message: "The token reply could not be read.".into(),
                })
            })?,
            // Revoked from the dashboard, expired, or the family was ended
            // because a retired token was used: the stored token is dead.
            Err(Failure::OAuth(code)) if code == "invalid_grant" => {
                self.forget();
                return Err(AccountError::SignedOut);
            }
            Err(other) => return Err(AccountError::Failed(other)),
        };
        if let Some(next) = tokens.refresh_token {
            self.save(&Stored {
                refresh_token: next,
                ..stored
            })?;
        }
        self.keep(tokens.access_token.clone(), tokens.expires_in);
        Ok(tokens.access_token)
    }

    /// A GET on the account service as the signed-in person. A 401 drops the
    /// access token and tries once more with a fresh one.
    pub fn get(&self, api: &str, path: &str) -> Result<Value, AccountError> {
        let url = wire::url(api, path);
        for attempt in 0..2 {
            let token = self.access_token(api)?;
            match wire::get(&url, &token) {
                Ok(value) => return Ok(value),
                Err(Failure::Unauthorized) if attempt == 0 => *lock(&self.access) = None,
                Err(Failure::Unauthorized) => return Err(AccountError::SignedOut),
                Err(other) => return Err(AccountError::Failed(other)),
            }
        }
        Err(AccountError::SignedOut)
    }

    /// Revoke the refresh token (best effort, RFC 7009), then forget it.
    /// Local forgetting happens whatever the network says.
    pub fn sign_out(&self, api: &str) {
        if let Some(stored) = self.stored(api) {
            let _ = wire::post_form(
                &wire::url(api, "v1/oauth/revoke"),
                &[
                    ("token", &stored.refresh_token),
                    ("token_type_hint", "refresh_token"),
                    ("client_id", wire::CLIENT_ID),
                ],
            );
        }
        self.forget();
    }
}

#[cfg(test)]
mod tests;
