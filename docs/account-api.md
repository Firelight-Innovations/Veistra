# Account API: what the desktop app sends

The desktop app's half of the contract with the Veistra account service (`api` in the
`veistra-cloud` repo). The system design doc ("Veistra Accounts, Dashboard and Docs: System
Design") decides the behaviour; this page pins the requests and replies the app depends on.
`src-tauri/src/account/` implements it, and `account/tests.rs` runs every case below against a
scripted server.

If the service needs a different shape, change this page and `account/wire.rs` in the same pull
request.

## Base address

The app calls Cloud Run's `run.app` address directly, never through Firebase Hosting, which cuts
requests at 60 s. The address is the `account.apiUrl` setting (Settings, Account), or the
`VEISTRA_ACCOUNT_API` environment variable, and is everything before `/v1`. Empty means "not
deployed yet": the app shows no sign-in screen and the account panel says so.

## Conventions

- OAuth endpoints (`/v1/device/code`, `/v1/oauth/token`, `/v1/oauth/revoke`) take
  `application/x-www-form-urlencoded` bodies, as RFC 6749, 7009 and 8628 specify. They carry no
  cookie, so the JSON-only CSRF rule for cookie-authenticated endpoints does not apply.
- OAuth errors are `{"error": "<code>"}` with HTTP 400 (RFC 6749 §5.2).
- Every other error is a problem document (RFC 9457): `type`, `title`, `detail`. The app shows
  `detail`, else `title`.
- HTTP 401 on a bearer request means the access token was refused. The app refreshes once and
  retries; a second 401 reads as signed out.
- `client_id` is `veistra-desktop` on every OAuth request.
- Money is integer micro-dollars (`*_micros`). JSON keys are `snake_case`.

## Signing in (RFC 8628)

### `POST /v1/device/code`

Form: `client_id`, `device_name` (the Windows computer name), `os` (`Windows`), `app_version`.

```json
{
  "device_code": "<32 random bytes, base64url>",
  "user_code": "KQ74MX",
  "verification_uri": "https://veistra.com/device",
  "verification_uri_complete": "https://veistra.com/device?code=KQ74MX",
  "expires_in": 600,
  "interval": 5
}
```

The app opens `verification_uri_complete` (falling back to `verification_uri`) in the browser, and
only if it is `https:`. It shows `user_code` as two groups of three: `KQ7-4MX`.

### `POST /v1/oauth/token`, device-code grant

Form: `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code`, `client_id`.

The app waits `interval` seconds before each poll (5 if absent) and reacts to:

| Reply | App does |
|---|---|
| 400 `authorization_pending` | Polls again |
| 400 `slow_down` | Adds 5 s to the interval, polls again |
| 400 `access_denied` | Stops; shows "Sign-in cancelled" (the approve screen's Cancel calls deny) |
| 400 `expired_token` | Stops; shows "This code expired" |
| No answer (network) | Polls again until the code's own expiry |
| 200 tokens | Calls `GET /v1/me`, stores the refresh token, shows "Signed in" |

The app also stops on its own once `expires_in` has passed, without another request.

```json
{ "access_token": "<ES256 JWT>", "token_type": "Bearer", "expires_in": 900, "refresh_token": "<32 random bytes>" }
```

### Refreshing: `POST /v1/oauth/token`, refresh grant

Form: `grant_type=refresh_token`, `refresh_token`, `client_id`. The reply has the same shape and a
**new** `refresh_token`; the app writes it to Windows Credential Manager before it uses the new
access token.

- `400 invalid_grant` (revoked, expired, or the family ended after reuse): the app deletes its
  stored token and shows the sign-in screen.
- The app never sends two refreshes at once. Two requests with the same token would look like a
  copied token and end the device's family.
- If a refresh reply is lost on the network, the server has already rotated the token and the
  app still holds the old one. Its next refresh is reuse, the family ends, and the person signs in
  again. That is the design working as intended, not a bug to work around.

### `POST /v1/oauth/revoke` (RFC 7009)

Form: `token`, `token_type_hint=refresh_token`, `client_id`. Any reply is accepted; the app forgets
the token locally whatever happens.

## Reads

All take `Authorization: Bearer <access token>`.

### `GET /v1/me`

```json
{
  "user": { "id": "…", "email": "b@example.com", "name": "Braden Seaborn" },
  "workspace": { "id": "…", "name": "Personal workspace", "plan": "beta" }
}
```

### `GET /v1/usage?range=period|7d|30d[&project=<name>]`

`period` is the current billing month. Today is live (raw `usage_events`); past days come from
`usage_daily`. The web dashboard reads the same endpoint, so both show the same numbers.

```json
{
  "range": { "from": "2026-11-01", "to": "2026-11-04" },
  "period": { "from": "2026-11-01", "to": "2026-11-30", "resets": "2026-12-01" },
  "totals": {
    "cost_micros": 18400000,
    "by_source": {
      "veistra_harness": { "cost_micros": 9600000, "quantity": 4710000, "unit": "token" },
      "cloud_worker": { "cost_micros": 4200000, "quantity": 16000, "unit": "second" },
      "gpu_render": { "cost_micros": 4600000, "quantity": 3600, "unit": "second" }
    },
    "unbilled_runs": { "own_claude": 31, "own_codex": 14 }
  },
  "daily": [{ "day": "2026-11-01", "source": "veistra_harness", "cost_micros": 300000 }],
  "projects": ["Anomaly", "Torn Apart"],
  "limit": {
    "monthly_limit_micros": 50000000,
    "spent_this_period_micros": 18400000,
    "alert_pct": 80,
    "pause_at_limit": true,
    "projected_date": "2026-11-14"
  },
  "synced_at": "2026-11-04T17:42:00Z"
}
```

`limit` is `null` when the workspace has no limit. `projected_date` is computed by the server
(remaining budget over the last 7 days' average daily spend) and is `null` with fewer than 3 days
of data, so the web and the app never disagree about it.

### `GET /v1/runs[?project=<name>&cursor=<opaque>&limit=<n>]`

Newest first.

```json
{
  "runs": [
    {
      "id": "…", "name": "Generate crate variants", "project": "Anomaly",
      "harness": "veistra_harness", "status": "finished",
      "started_at": "2026-11-04T17:20:00Z", "tokens": 560000,
      "cost_micros": 380000, "billed": true
    }
  ],
  "next_cursor": null
}
```

`harness` is one of `veistra_harness`, `claude_code`, `codex`, `cloud_worker`, `gpu_render`.
`status` is `running`, `finished` or `failed`. `billed: false` rows (own Claude, own Codex) show
"Your plan" in place of a cost.

## Not yet sent by the app

- `POST`, `PATCH /v1/runs` (recording runs, including unbilled ones).
- `POST /v1/models/messages` on the gateway. The access token for it comes from
  `Account::access_token`.
