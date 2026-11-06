//! The `account/*` methods, as Home and the shell reach them.
//!
//! One dispatch shared by everything that shows the account, the way `files`
//! and `viewer` share theirs: there is one sign-in, so there is one place that
//! answers for it. Home's own `call` hands `account/*` here, and the shell's
//! title-bar avatar and Settings pages reach it through [`account_call`].

use super::{Account, AccountError, DeviceInfo};
use crate::settings::{self, keys};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use veistra_rpc::{RpcError, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND};

/// Overrides the setting, for an agent's instance pointed at a test server.
const API_ENV: &str = "VEISTRA_ACCOUNT_API";

/// The pages "Open on veistra.com" may open, by name. A frame names a page;
/// it never hands over a URL, so it cannot point the browser anywhere else.
const WEB_PAGES: &[(&str, &str)] = &[
    ("dashboard", "dashboard"),
    ("usage", "dashboard/usage"),
    ("docs", "docs"),
];

/// The account service's base address: everything before `/v1`.
pub fn api(app: &AppHandle) -> String {
    std::env::var(API_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| settings::text(app, keys::ACCOUNT_API_URL))
        .trim()
        .to_string()
}

fn web(app: &AppHandle) -> String {
    settings::text(app, keys::ACCOUNT_WEB_URL)
        .trim()
        .to_string()
}

// --- the one choice that is not a credential --------------------------------

const FILE: &str = "account.json";

/// Reconstructible: losing it shows the sign-in screen once more.
const KEEP: crate::userdata::store::Keep = crate::userdata::store::Keep::Nothing;

/// "Use my own Claude or Codex sign-in": the person chose to run agents on
/// their own plan, so the sign-in screen stops standing in front of Home.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Choices {
    own_sign_in: bool,
}

fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join(FILE))
}

fn choices(app: &AppHandle) -> Choices {
    file(app)
        .map(|path| crate::userdata::store::read(&path, KEEP))
        .unwrap_or_default()
}

fn save_choices(app: &AppHandle, choices: &Choices) {
    if let Some(path) = file(app) {
        crate::userdata::store::write(&path, choices, "the account choice");
    }
}

// --- dispatch -----------------------------------------------------------------

fn rpc(error: AccountError) -> RpcError {
    let mut e = RpcError::new(INTERNAL_ERROR, error.describe());
    e.data = Some(json!({ "reason": error.reason() }));
    e
}

fn status(app: &AppHandle) -> Value {
    let account = app.state::<Account>();
    let mut value = serde_json::to_value(account.status(&api(app))).unwrap_or(Value::Null);
    value["ownSignIn"] = json!(choices(app).own_sign_in);
    value
}

fn text_param<'a>(params: Option<&'a Value>, key: &str) -> Option<&'a str> {
    params
        .and_then(|p| p.get(key))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// Query string for `/v1/usage` and `/v1/runs`, from the few params a frame
/// may pass. Values are percent-encoded; anything else in `params` is ignored.
fn query(params: Option<&Value>, keys: &[&str]) -> String {
    let pairs: Vec<String> = keys
        .iter()
        .filter_map(|k| {
            text_param(params, k).map(|v| format!("{k}={}", crate::cloud::http::encode(v)))
        })
        .collect();
    if pairs.is_empty() {
        String::new()
    } else {
        format!("?{}", pairs.join("&"))
    }
}

/// The shell's door to [`call`]: the title bar's account menu and the Account,
/// Billing and Usage pages of Settings. Those are not app frames, so they have
/// no `app_call` instance to name; this is the same dispatch Home reaches.
///
/// On a blocking worker for the reason `commands::app_call` gives: every read
/// here is an HTTP round trip to the account service, and a synchronous command
/// would hold the main thread for it.
#[tauri::command]
pub async fn account_call(
    app: AppHandle,
    method: String,
    params: Option<Value>,
) -> Result<Value, RpcError> {
    tauri::async_runtime::spawn_blocking(move || call(&app, &method, params))
        .await
        .unwrap_or_else(|e| {
            Err(RpcError::new(
                INTERNAL_ERROR,
                format!("the account call did not complete: {e}"),
            ))
        })
}

pub fn call(app: &AppHandle, method: &str, params: Option<Value>) -> Result<Value, RpcError> {
    let api = api(app);
    let account = app.state::<Account>();
    match method {
        "account/status" => Ok(status(app)),

        "account/sign-in" => {
            let started = account
                .start(&api, &DeviceInfo::this_computer())
                .map_err(rpc)?;
            open(app, &started.waiting.verification_uri_complete)?;
            let handle = app.clone();
            std::thread::spawn(move || {
                handle.state::<Account>().poll(
                    &api,
                    started.generation,
                    started.interval,
                    &std::thread::sleep,
                );
            });
            Ok(status(app))
        }

        "account/cancel-sign-in" => {
            account.cancel();
            Ok(status(app))
        }

        "account/dismiss" => {
            account.dismiss();
            Ok(status(app))
        }

        "account/use-own-sign-in" => {
            account.dismiss();
            save_choices(app, &Choices { own_sign_in: true });
            Ok(status(app))
        }

        "account/sign-out" => {
            account.sign_out(&api);
            Ok(status(app))
        }

        "account/me" => account.get(&api, "v1/me").map_err(rpc),

        // The profile picture (`docs/account-api.md`). The shell shrinks a
        // picked file to a 256-pixel WebP before it gets here, so `image` is
        // a few KB of base64; the service checks what it really is.
        "account/avatar" => account.picture(&api).map_err(rpc),
        "account/set-avatar" => {
            let image = text_param(params.as_ref(), "image")
                .ok_or_else(|| RpcError::new(INVALID_PARAMS, "image is the picture, as base64"))?;
            account
                .write(&api, "PUT", "v1/me/avatar", &json!({ "image": image }))
                .map_err(rpc)
        }
        "account/remove-avatar" => account
            .write(&api, "DELETE", "v1/me/avatar", &Value::Null)
            .map_err(rpc),

        "account/usage" => {
            let range = text_param(params.as_ref(), "range").unwrap_or("period");
            if !["period", "7d", "30d"].contains(&range) {
                return Err(RpcError::new(
                    INVALID_PARAMS,
                    "range is one of period, 7d or 30d",
                ));
            }
            let q = query(params.as_ref(), &["range", "project"]);
            account.get(&api, &format!("v1/usage{q}")).map_err(rpc)
        }

        "account/runs" => {
            let q = query(params.as_ref(), &["project", "cursor", "limit"]);
            account.get(&api, &format!("v1/runs{q}")).map_err(rpc)
        }

        "account/open-web" => {
            let page = text_param(params.as_ref(), "page").unwrap_or("dashboard");
            let path = WEB_PAGES
                .iter()
                .find(|(name, _)| *name == page)
                .map(|(_, path)| *path)
                .ok_or_else(|| RpcError::new(INVALID_PARAMS, format!("no page named {page}")))?;
            open(app, &format!("{}/{path}", web(app).trim_end_matches('/')))?;
            Ok(Value::Null)
        }

        _ => Err(RpcError::new(
            METHOD_NOT_FOUND,
            format!("no account method {method}"),
        )),
    }
}

/// The system browser. Only `https:` (or `http:` on loopback, for a test
/// server) is opened: the address came from the account service.
fn open(app: &AppHandle, url: &str) -> Result<(), RpcError> {
    use tauri_plugin_opener::OpenerExt;
    if !safe_to_open(url) {
        return Err(RpcError::new(
            INTERNAL_ERROR,
            "the account service sent a sign-in address this app will not open",
        ));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| RpcError::new(INTERNAL_ERROR, format!("could not open the browser: {e}")))
}

pub fn safe_to_open(url: &str) -> bool {
    match url::Url::parse(url) {
        Ok(u) if u.scheme() == "https" => true,
        Ok(u) if u.scheme() == "http" => {
            matches!(u.host_str(), Some("127.0.0.1") | Some("localhost"))
        }
        _ => false,
    }
}
