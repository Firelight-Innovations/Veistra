//! What crosses the wire to the Veistra account service, and the one function
//! that sends it. `docs/account-api.md` is the contract; the shapes below are
//! its app-side half and must change with it.
//!
//! Nothing here ever puts a token in an error. A failure carries the HTTP
//! status, the OAuth `error` code or the problem's `title` and `detail`
//! (RFC 9457), and never any part of the request.

use serde::Deserialize;
use serde_json::Value;

/// RFC 8628 §3.4.
pub const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// The OAuth client the desktop app identifies as. Public, like every
/// installed-app client ID: it names the app, it does not authenticate it.
pub const CLIENT_ID: &str = "veistra-desktop";

/// Replies are small JSON documents. A larger one is a fault, not data.
const LIMIT: u64 = 1 << 20;

/// RFC 8628 §3.2, the device authorization response.
#[derive(Debug, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default)]
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    /// Seconds between polls. RFC 8628 says 5 when absent.
    #[serde(default)]
    pub interval: Option<u64>,
}

/// RFC 6749 §5.1, as the token endpoint answers both grants.
#[derive(Debug, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub expires_in: Option<u64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
}

/// Why a request did not produce what was asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// No HTTP answer at all: DNS, TLS, a timeout, a reset.
    Unreachable(String),
    /// An OAuth error reply (RFC 6749 §5.2): `authorization_pending`,
    /// `slow_down`, `access_denied`, `expired_token`, `invalid_grant`.
    OAuth(String),
    /// HTTP 401 on a bearer request: the access token was refused.
    Unauthorized,
    /// Any other non-2xx reply.
    Status {
        status: u16,
        /// The problem `type`, such as `limit-reached`, when the body was one.
        kind: Option<String>,
        message: String,
    },
}

impl Failure {
    /// A sentence for a person. Names the service, never the request.
    pub fn describe(&self) -> String {
        match self {
            Failure::Unreachable(detail) => {
                format!("The Veistra account service did not answer ({detail}).")
            }
            Failure::OAuth(code) => format!("The Veistra account service refused this ({code})."),
            Failure::Unauthorized => "This computer is no longer signed in to Veistra.".into(),
            Failure::Status { message, .. } => message.clone(),
        }
    }
}

#[derive(Deserialize)]
struct OAuthError {
    error: String,
}

#[derive(Deserialize)]
struct Problem {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    detail: Option<String>,
}

/// `base` + `path`, with exactly one slash between them. `base` is the
/// setting, which a person types and may end with a slash.
pub fn url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// One form POST (the OAuth endpoints take forms, RFC 6749 §4.1.3).
pub fn post_form(url: &str, form: &[(&str, &str)]) -> Result<Value, Failure> {
    let response = crate::cloud::http::agent()
        .post(url)
        .header("Accept", "application/json")
        .send_form(form.iter().copied());
    read(response)
}

/// One GET with a bearer token.
pub fn get(url: &str, bearer: &str) -> Result<Value, Failure> {
    let response = crate::cloud::http::agent()
        .get(url)
        .header("Accept", "application/json")
        .header("Authorization", &format!("Bearer {bearer}"))
        .call();
    read(response)
}

fn read(response: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<Value, Failure> {
    let mut response = response.map_err(|e| Failure::Unreachable(e.to_string()))?;
    let status = response.status().as_u16();
    let body = response
        .body_mut()
        .with_config()
        .limit(LIMIT)
        .read_to_vec()
        .map_err(|e| Failure::Unreachable(e.to_string()))?;
    if (200..300).contains(&status) {
        if body.is_empty() {
            return Ok(Value::Null);
        }
        return serde_json::from_slice(&body).map_err(|_| Failure::Status {
            status,
            kind: None,
            message: "The Veistra account service sent a reply this version cannot read.".into(),
        });
    }
    Err(failure(status, &body))
}

/// An error body as a [`Failure`]. A 401 is always [`Failure::Unauthorized`],
/// whatever its body says (RFC 6750 §3.1). OAuth's `{"error": …}` wins over a problem
/// document, because the token endpoint's callers branch on the code.
pub fn failure(status: u16, body: &[u8]) -> Failure {
    if status == 401 {
        return Failure::Unauthorized;
    }
    if let Ok(e) = serde_json::from_slice::<OAuthError>(body) {
        return Failure::OAuth(e.error);
    }
    let problem = serde_json::from_slice::<Problem>(body).ok();
    let kind = problem.as_ref().and_then(|p| p.kind.clone());
    let message = problem
        .and_then(|p| p.detail.or(p.title))
        .unwrap_or_else(|| format!("The Veistra account service answered HTTP {status}."));
    Failure::Status {
        status,
        kind,
        message,
    }
}
