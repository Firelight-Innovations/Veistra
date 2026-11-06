# Account API: what the desktop app sends

The desktop app's half of the contract with the Veistra account service, which lives in the
website repository (Firelight-Innovations/Veistra-Website, `services/account/`; its half is that
repository's `docs/account-api.md`). The system design doc ("Veistra Accounts, Dashboard and Docs: System
Design") decides the behaviour; this page pins the requests and replies the app depends on.
`src-tauri/src/account/` implements it, and `account/tests.rs` runs every case below against a
scripted server.

If the service needs a different shape, change this page and `account/wire.rs` in the same pull
request.

## Base address

The app calls Cloud Run's `run.app` address directly, never through Firebase Hosting, which cuts
requests at 60 s. The address is everything before `/v1`:

- the `VEISTRA_ACCOUNT_API` environment variable, for an agent's instance pointed at a test
  service;
- else the `account.apiUrl` setting (Settings → Developer → Account service), whose default is the
  production service, `https://account-622707038832.us-central1.run.app`.

Empty turns Veistra accounts off in that build: the app shows no sign-in screen, and Settings →
Account and Usage say so.

`account.webUrl` is the website: the approve page, "Manage on veistra.com", "Open on veistra.com"
and the Docs pages. Its default is `https://veistra.com`, served by Firebase Hosting, which
forwards `/api/**` to the service. It is also the origin the service puts in `verification_uri`
(its `SITE_ORIGIN`), so the browser holds one session cookie for both; the two change together.
`https://veistra-prod.web.app`, Hosting's own domain, serves the same site and stays signed-in
capable, for builds made before the domain moved.

The shell reads these endpoints through the `account/*` methods (`src-tauri/src/account/`): Home
calls them as an app, and the shell's title-bar avatar and Settings' Account, Billing and Usage
pages call them through the `account_call` command (`accountCall` in `src/bindings.ts`). Settings →
Usage, which replaced the Usage app, reads `GET /v1/usage` and `GET /v1/runs`.

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
| 5xx, or 429 (Cloud Run's own front end) | Polls again until the code's own expiry: the service leaves an approved code approved, so a later poll collects the tokens |
| Any other error | Stops; shows the problem's `detail` (else `title`) |
| 200 tokens | Calls `GET /v1/me`, stores the refresh token, shows "Signed in" |

`access_denied` also answers a denied code that has since expired, a code approved for an account
that was disabled before the app collected it, and a code whose device was signed out first. All
read as "Sign-in cancelled". An approval in a code's last seconds keeps it alive one more minute,
so the next poll still collects the tokens.

The app also stops on its own once `expires_in` has passed, without another request.

```json
{ "access_token": "<ES256 JWT>", "token_type": "Bearer", "expires_in": 900, "refresh_token": "<32 random bytes>" }
```

### Refreshing: `POST /v1/oauth/token`, refresh grant

Form: `grant_type=refresh_token`, `refresh_token`, `client_id`. The reply has the same shape and a
**new** `refresh_token`; the app writes it to Windows Credential Manager before it uses the new
access token.

- `400 invalid_grant` (revoked, expired, the account disabled, or the family ended after reuse):
  the app deletes its stored token and shows the sign-in screen.
- `429` with `Retry-After: 60` (this address's refresh budget is spent): the app keeps its refresh
  token, shows the problem's words ("Too many requests. Wait a minute, then try again."), and the
  next read tries again. It never signs out on a 429 or a 5xx.
- The app never sends two refreshes at once. Two requests with the same token would look like a
  copied token and end the device's family.
- If a refresh reply is lost on the network, the server has already rotated the token and the
  app still holds the old one. Its next refresh is reuse, the family ends, and the person signs in
  again. That is the design working as intended, not a bug to work around.

### `POST /v1/oauth/revoke` (RFC 7009)

Form: `token`, `token_type_hint=refresh_token`, `client_id`. Any reply is accepted; the app forgets
the token locally whatever happens.

### Rate limits

Each Cloud Run instance keeps its limits in memory, one budget per purpose: device codes and the
token endpoint per address, run writes per device. The address is the last `X-Forwarded-For`
entry Google's front end saw, which for the app (calling `run.app` directly) is its own. IPv6 is
counted by /64.

- `POST /v1/device/code` over its limit: `429` problem, `Retry-After: 60`. The app shows its words.
- A device-code poll over its limit: `400 {"error": "slow_down"}`, never a 429 problem.
- A refresh over its limit: `429`, as above.

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
  "plan": {
    "id": "pro", "name": "Pro", "price_micros": 10000000,
    "included_micros": 10000000, "used_micros": 10000000, "remaining_micros": 0,
    "resets": "2026-12-01"
  },
  "limit": {
    "monthly_limit_micros": 50000000,
    "spent_this_period_micros": 8400000,
    "alert_pct": 80,
    "pause_at_limit": true,
    "projected_date": "2026-11-14"
  },
  "synced_at": "2026-11-04T17:42:00Z"
}
```

`plan` is the workspace's plan and this month's included credits, whatever the range. Included
credits pay for billed usage first and reset with the month; the beta plan includes none and
answers zeros. Optional: a service older than plans leaves it out, and the app reads that as no
credits.

`limit` is `null` when the workspace has no limit. It caps only spend past the plan's credits, so
`spent_this_period_micros` is the month's spend minus what the credits paid for (above, 18.40
spent, 10.00 of it from credits). `limit.alert_pct` is `null` when the 80% email
is off, which the dashboard can do; Settings → Usage then says "No spend alert". `projected_date`
is computed by the server (what is left of the credits and the limit together, over the last 7
days' average daily spend) and is `null` with fewer than 3 days of spend or when it falls after
the billing period, so the web and the app never disagree about it. The app never recomputes it.

Days are UTC calendar days, and `period` is the current UTC month. `7d` and `30d` end today and
include it. `by_source` lists only sources with spend in the range, and `daily` only days with
spend; the chart fills the gaps with zero. `projects` names every project the workspace has used,
whatever the filter. Billed sources are written by the service's own gateway and workers, which
are not built yet, so every billed total is `0` until they are.

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
"Your plan" in place of a cost: they never use a plan's credits and never count against the
limit. `limit` defaults to 20 and is capped at 100; `next_cursor` is
opaque, and a cursor the service did not send is `400`. The runs are the newest of every range:
this endpoint takes a project, not dates.

## Writes

### `POST /v1/runs`, `PATCH /v1/runs/{id}`

The app records each Claude Code and Codex session as one run, so they show in `unbilled_runs`
and the runs list here and on the dashboard (`src-tauri/src/account/runs.rs`). One run is one
agent session: from the harness process starting in an agent tab to its stopping, as the agent
host reports each session's state. A Veistra harness session is not sent; billed work is metered
by the service, never reported by a client. Rejected: a run per prompt, which counted every
message of a conversation as a run.

- Bearer token and a JSON body. A cookie is refused, so the website cannot write a run.
- `POST` when the session starts: `{"id": "<UUID the app chooses>", "name": "Claude Code session"
  | "Codex session", "project": "<the working folder's name>", "harness": "claude_code" |
  "codex"}`. Never a prompt, the session's title (the agent writes it from the prompts) or a
  path. The service sets `started_at` and `status: "running"`, and answers `201` with the run in
  the `/v1/runs` shape. The same `id` again answers the same run, so a retry after a lost reply
  is still one run; there is no `Idempotency-Key` header. Another workspace's `id` is `409`.
- A billed harness is `400`: a client never states a cost.
- `PATCH` when it stops: `{"status": "finished" | "failed", "tokens": null}`. The agent host
  reports a session's context size, not tokens used, so the app sends none. A tab that switches
  harness finishes the old run before it starts the new one. A billed run, or another
  workspace's, is `404`.
- Best effort, on a thread of its own: signed out or offline, the run is not sent and not
  retried. A run open when Veistra quits stays `running`.
- Settings → Usage → "Show Claude Code and Codex sessions on your dashboard" (`runs.record`, on by
  default) stops new runs; an open one still finishes.
- Run writes have their own budget per device.

## Not yet sent by the app

### The gateway

`POST /v1/models/messages`. The access token for it comes from `Account::access_token`.

## Known gap

If the reply to a successful refresh is lost on the network, the server has already rotated the
token, so the app's retry with the old one reads as reuse and ends the family: the person signs
in again. Nothing on either side can tell that apart from a copied token (website review, F40).
