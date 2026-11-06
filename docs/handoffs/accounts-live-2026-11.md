# Handoff: the app against the live account service (sign-in now, usage and spend next)

> **Superseded in part, 2026-11-05.** §1.1's `https://veistra.com/api` would not work: veistra.com
> is still Render's static site, which has no `/api`. The app now defaults to the `run.app`
> address and to `https://veistra-prod.web.app`. `GET /v1/usage`, `GET /v1/runs`,
> `POST`/`PATCH /v1/runs` and `PUT /v1/limits` are built (Firelight-Innovations/Veistra-Website#18),
> and §3.1's runs shape is not the one the service takes. `docs/account-api.md` is current.

From the website session, 2026-11-04. For whoever updates the Veistra app next.

The account service exists now. It lives in the **website** repository, `services/account/`
(Firelight-Innovations/Veistra-Website#13), runs on Cloud Run, and is reached at
`https://veistra.com/api/v1/...` through Firebase Hosting. Its one-time setup is
`docs/firebase-hosting.md` in that repository. Nothing below works until that setup is done.

| Area | State |
|---|---|
| Web sign-in (Google, GitHub, email link), `/v1/me`, sessions | **Built**, in #13 |
| Desktop sign-in (RFC 8628): device code, approve/deny, tokens, refresh, revoke | **Built**, in #13 |
| Devices: list, sign one out, sign out everywhere | **Built**, in #13 |
| `GET /v1/usage`, `GET /v1/runs` (the Usage app's reads) | **Not built**: answers 404 today |
| `POST`/`PATCH /v1/runs`, `PUT /v1/limits`, API keys, `POST /v1/usage/machine` | **Not built** |
| The gateway, `POST /v1/models/messages` (metering and the spend limit) | **Not built** |

## 1. Sign-in: what the app must change

The app's client (`src-tauri/src/account/`) was written against `docs/account-api.md`, and the
service implements that contract. I checked it end to end against the real service code:

1. A device code is issued.
2. The poll answers `authorization_pending`, then `slow_down` when it comes too fast.
3. Approving in the browser lets the next poll get tokens.
4. `/v1/me` works with the access token.
5. Refreshing rotates the refresh token.
6. Reusing an old refresh token ends the family.
7. Revoking removes the device.

So the sign-in flow needs **no protocol changes**. What does need doing:

### 1.1 Point the app at the service (required)

`account.apiUrl` defaults to empty, which hides the sign-in screen. Set its default to
**`https://veistra.com/api`** in `src-tauri/src/settings/schema.rs`, and update the setting's
description, which still talks about the `run.app` address.

The service answers both `/api/v1/...` (through Hosting) and `/v1/...` (on Cloud Run directly), so
either base works. Use the Hosting address for the account service:
- it is stable;
- it needs no per-deploy `run.app` hostname;
- every account call is short.

The 60-second Hosting limit that made the system design send the app to `run.app` only matters
for the gateway's model streams (§3.2), which will have their own address.

`VEISTRA_ACCOUNT_API` still overrides it, for an agent's instance pointed at a test service.

### 1.2 Register `veistra://` with the OS (required for two links)

Two website links open the app, and nothing in `src-tauri` registers the scheme with Windows today:
- "Open the Veistra app" on the approve page goes to `veistra://open`.
- "Open in Veistra" on every docs page goes to `veistra://docs/<slug>`, for example
  `veistra://docs/context/blender`.

Add `tauri-plugin-deep-link`, register `veistra`, and handle:
- `veistra://open`: bring the main window forward.
- `veistra://docs/<slug>`: open the docs viewer at that page (§4). Until there is one, open
  `https://veistra.com/docs/<slug>` in the browser.

The scheme is already used *inside* the app (`veistra://canvas/`, `veistra://context/`). Route the
OS deep link only for `open` and `docs/`, so a web page cannot drive canvas or context navigation.

### 1.3 Smaller things

- **Only the beta is let in.** A session needs the address on `beta_allowlist`. Someone without
  beta access cannot approve in the browser (the website tells them), so the app just waits until
  "This code expired". Optional: under the code, add "Your account needs beta access" with a link
  to `/contact`.
- **The OS string.** The app sends `os=Windows`. The approve page and the dashboard show it as
  "Windows · Veistra 0.1.0". Sending "Windows 11" (from the build number) makes the approve screen
  more useful. The service accepts up to 100 characters per field.
- **No location yet.** `location` on the approve page is always `null`: Cloud Run gives no
  geolocation. Nothing to do in the app.
- **Sign-out from the dashboard.** It revokes the device. The app's next request with its access
  token gets 401, and the refresh gets `invalid_grant`, so it lands on the sign-in screen. The app
  already handles both (`account/tests.rs`). The service checks the device on every request with
  an access token, with no 30-second cache yet, so this is immediate.
- **Lifetimes, as built.**
  - Access token: 15 minutes.
  - Refresh token: 30 days from its last use, 90 days at most for the family.
  - Device code: 10 minutes, polled every 5 seconds, plus 5 seconds after each `slow_down`.
  - Six-character codes, sent without the dash.

### 1.4 Access token format (for the gateway, later)

- **Format:** ES256 JWTs. Header `kid`; claims `iss`, `aud: "veistra"`, `sub` (user), `ws`
  (workspace), `dev` (device), `scope: "app"`, `iat`, `exp`.
- **Public keys:** at `/.well-known/jwks.json`.
- **The app** keeps treating the token as opaque. Only services read it.

## 2. Usage: what is coming, and what the app can do now

The Usage app (`apps/usage/`) reads `GET /v1/usage` and `GET /v1/runs`, exactly as the website's
dashboard does. Both answer **404** until the next service PR. Until then:

- Show "Usage arrives with the next update" on a 404 from those two calls, instead of the raw
  "No such endpoint." the app would print today. One branch in `App.tsx`, keyed on the problem
  `type` ending in `not-found`.
- **Type fix to make now.** The website contract allows `limit.alert_pct: null` when the 80% email
  is off. `apps/usage/ui/src/usage.ts` types it `number`; make it `number | null`. The app does not
  show it, so this only keeps the types honest.

When the endpoints land, the numbers need no app change: the app and the web read the same reply,
and the web's arithmetic is a port of the app's.

## 3. Spend and metering (the "credit" side): app work once the server side lands

The system design meters **spend in USD** against a **monthly limit** (`*_micros`). It has no
prepaid credit balance. If "credits" should mean a prepaid balance people top up, that is a new
product decision: billing provider, top-up flow, and what happens at zero. Decide that before
either side builds it; everything below is the design as written.

### 3.1 Record runs: `POST /v1/runs`, `PATCH /v1/runs/{id}` (app)

The app reports every agent run, including those on the person's own Claude Code or Codex sign-in,
so the dashboard can count them:

- `POST` when a run starts: `name`, `project`, `harness` (`veistra_harness`, `claude_code`,
  `codex`, `cloud_worker`, `gpu_render`), `started_at`.
- `PATCH` when it ends: `status` (`finished` or `failed`) and `ended_at`.
- Send an `Idempotency-Key` header (a UUID per run), so a retried request never records twice.
- Nothing the app reports is billed. Billing comes only from the server's own meters. That is
  deliberate: a modified client could report anything.

### 3.2 Model calls through the gateway: `POST /v1/models/messages` (app)

Veistra-harness model calls move from the app's own key to the gateway:
- **Credential:** the access token from `Account::access_token`.
- **Body:** Anthropic Messages shaped.
- **Reply:** streamed.
- **Address:** its own setting, on `run.app`, because Hosting would cut a stream at 60 seconds.
- **`402` with problem type `limit-reached`:** the workspace paused billed runs at its limit.
  Stop the run, show "Billed runs are paused: this workspace reached its monthly limit", and link
  "Open on veistra.com" to `usage` (already in `WEB_PAGES`). Runs on the person's own Claude or
  Codex sign-in keep going.
- **When it bills:** after the stream ends, or at the point it broke, from the provider's own
  token counts.

### 3.3 Limits

Setting the limit stays on the website (`/dashboard/usage`, `PUT /v1/limits`). The app shows it
read-only in the Usage app's limit panel, as it does today, and opens the web page to change it.

## 4. Docs in the app (related, same release)

The website now publishes `https://veistra.com/docs/manifest.json`:
- `version` is the newest page date as a number, for example `20261104`.
- `hash` is a SHA-256 over every page.
- `nav` holds sections in order, with Beta flags and page slugs.
- `pages` holds each page's front matter, `url` and Markdown.

The plan:
1. Ship the copy from the release build.
2. Fetch the manifest at launch.
3. Take the new pages when `version` is higher **or** `hash` differs, so an edit that forgot to
   bump its date still arrives.

Raw HTML never appears in the Markdown; the website's build refuses it. Each page is also at
`/docs/<slug>.md`, and `/llms.txt` lists them all, for "Add page to agent context".

## 5. Testing the app against the service

The website repository runs the service locally:

```sh
BETA_ALLOWLIST_DEV=you@studio.com pnpm dev:account     # http://127.0.0.1:8080, memory store
```

`VEISTRA_ACCOUNT_API=http://127.0.0.1:8080` points the app at it. The app's half of the flow
(code, poll, tokens, refresh, revoke) runs against it as is. Approving needs a web session, and
that needs a real Identity Platform sign-in. So for the whole loop, use the deployed service (or a
staging one) with your address on the allow-list. `services/account/app.test.ts` shows every case
the service answers, and is the quickest way to see an exact reply.
