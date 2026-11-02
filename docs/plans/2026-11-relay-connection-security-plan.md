# Implementation Plan: Secure Cross-Origin Relay Onboarding, KeyVault Credential Sealing, Automatic Key Rolling & School SSO

> **Target Architecture:**
> - **Frontend Web App (Static Host):** Hosted on **Cloudflare Pages** or **GitHub Pages** (e.g. `https://kb.myschool.edu` or `https://school.github.io/kb-tools`).
> - **Relay Server (Separate Origin):** Hosted on **Cloudflare Workers + D1 (+ R2)** (e.g. `https://kb-relay.<subdomain>.workers.dev`) or a standalone Node.js/SQLite server.
> - **Core Security Mandate:** End users must **never** see raw plain-text connection keys/tokens in the UI, DOM inputs, or unencrypted IndexedDB tables. Onboarding links and codes must automatically roll keys upon first click via a cross-origin relay call so distributed links become single-use.

---

## 1. Architecture & End-to-End Flows

```mermaid
sequenceDiagram
    autonumber
    participant Admin as IT Admin (CLI / CSV)
    participant AppHost as Static App<br/>(CF Pages / GitHub Pages)
    participant Browser as Teacher Browser<br/>(KeyVault + IndexedDB)
    participant Worker as Relay Server<br/>(CF Worker + D1 / Node)
    participant IdP as School SSO<br/>(Google / Microsoft OIDC)

    rect rgb(240, 248, 255)
    Note over Admin,Worker: Flow A: Opaque Single-Use Link (#/connect?c=KBCON1...) or Claim Code
    Admin->>Worker: Seed teacher (stores SHA-256 of initial setup token / claim code)
    Admin->>Browser: Distributes opaque link: https://app-host/#/connect?c=KBCON1.<base64url>
    Browser->>AppHost: Loads static SPA; Router immediately scrubs URL bar (replaceState)
    Browser->>Worker: POST /api/v1/auth/roll (Authorization: Bearer <initial_token>)
    Worker->>Worker: Verifies initial token hash & active=1,<br/>generates new 256-bit token, updates D1 token_hash atomically
    Worker-->>Browser: 200 OK { token: <new_token>, teacher_id, name, quota }
    Browser->>Browser: Encrypts <new_token> inside KeyVault (AES-256-GCM)<br/>Stores only { baseUrl, teacherId, name, sealed: true } in sync_config
    end

    rect rgb(245, 255, 245)
    Note over Browser,IdP: Flow B: Zero-Link School SSO (Google Workspace / Microsoft Entra ID)
    Browser->>AppHost: Reads relay.baseUrl + cloud.google / cloud.microsoft from config.json
    Browser->>IdP: Opens OAuth/OIDC popup (openid email profile) -> oauth-callback.html
    IdP-->>Browser: Returns signed OIDC id_token JWT via BroadcastChannel
    Browser->>Worker: POST /api/v1/auth/oidc { provider, id_token }
    Worker->>Worker: Verifies RS256 JWT via WebCrypto + JWKS, checks domain/tenant & teacher email,<br/>issues fresh 256-bit bearer token & stores SHA-256 hash in D1
    Worker-->>Browser: 200 OK { token: <new_token>, teacher_id, name, quota }
    Browser->>Browser: Seals <new_token> in KeyVault; UI shows "Connected as <name>" (no plaintext token)
    end
```

---

## 2. Ground Rules for the Executing Agent

1. **Dual-Backend Parity (`db.js` + `d1-db.js`):**
   - Every schema or query change in [`server/relay/db.js`](file:///Users/mvanmierlo/Documents/kb-tools/server/relay/db.js) **must** have an identical async implementation in [`server/relay/d1-db.js`](file:///Users/mvanmierlo/Documents/kb-tools/server/relay/d1-db.js).
   - Bump `SCHEMA_VERSION` from `3` to `4` in [`server/relay/limits.js`](file:///Users/mvanmierlo/Documents/kb-tools/server/relay/limits.js).
   - Add idempotent `ALTER TABLE` migrations in both `createDatabase()` (`db.js`) and `initSchema()` (`d1-db.js`) so existing Cloudflare D1 and SQLite databases upgrade seamlessly without losing data.
2. **Codebase Conventions Enforced by Tests:**
   - Use `generateUUID` from [`src/utils/uuid.js`](file:///Users/mvanmierlo/Documents/kb-tools/src/utils/uuid.js), never `crypto.randomUUID` directly (`tests/no-direct-random-uuid.test.js`).
   - Use `ConfirmDialog` / `PromptDialog` from [`src/utils/dialogs.js`](file:///Users/mvanmierlo/Documents/kb-tools/src/utils/dialogs.js), never native `alert`/`confirm`/`prompt` (`tests/no-native-dialogs.test.js`).
   - Run `npm run build:sw` after adding any new module under `src/` so `sw-assets.js` stays in sync with Service Worker pre-caching tests.
3. **Zero Plaintext Credential Exposure:**
   - Never render a saved bearer token into an `<input>` or `<sl-input value="...">` in the DOM.
   - Never store a raw bearer token in unencrypted `app_metadata.sync_config`; seal it in `KeyVault` under the secret key `'relay_credentials'`.

---

## 3. Proposed Changes by Component

### Component 1: Database Schema v4 & Teacher Auth Repository (`server/relay/`)

Upgrade the `teachers` table to support:
- `active INTEGER NOT NULL DEFAULT 1` (for instant revocation/deactivation without cascading deletion of drops/feeds).
- `email TEXT` (optional, normalized lowercase, for OIDC SSO matching).
- `claim_hash TEXT` and `claim_expires_at TEXT` (for short one-time claim codes).
- `token_rotated_at TEXT` (audit timestamp of last automatic or manual key rotation).

#### [MODIFY] [server/relay/limits.js](file:///Users/mvanmierlo/Documents/kb-tools/server/relay/limits.js)
- Bump `SCHEMA_VERSION` from `3` to `4`.

#### [MODIFY] [server/relay/schema.sql](file:///Users/mvanmierlo/Documents/kb-tools/server/relay/schema.sql) & [server/relay/schema.js](file:///Users/mvanmierlo/Documents/kb-tools/server/relay/schema.js)
Update `teachers` DDL and add an index on `email` and `claim_hash`:
```sql
CREATE TABLE IF NOT EXISTS teachers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  claim_hash TEXT,
  claim_expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  bytes_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  token_rotated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_teachers_email ON teachers(email);
CREATE INDEX IF NOT EXISTS idx_teachers_claim ON teachers(claim_hash);
```

#### [MODIFY] [server/relay/db.js](file:///Users/mvanmierlo/Documents/kb-tools/server/relay/db.js) & [server/relay/d1-db.js](file:///Users/mvanmierlo/Documents/kb-tools/server/relay/d1-db.js)
1. **Migrations on startup:**
   - In `db.js` and `d1-db.js` (`initSchema`), run safe `ALTER TABLE teachers ADD COLUMN ...` for `email`, `claim_hash`, `claim_expires_at`, `active DEFAULT 1`, and `token_rotated_at` before updating `schema_version` to `4`.
2. **Update `db.teachers` methods in both files:**
   - `create({ id, name, email = null, tokenHash, claimHash = null, claimExpiresAt = null, active = 1, createdAt })`
   - `getByTokenHash(tokenHash)`: returns the teacher row **only if `active !== 0`** (or returns `{ ...row, deactivated: true }` so the handler can return `403 Forbidden: teacher account deactivated`).
   - `getByEmail(email)`: looks up `WHERE LOWER(email) = LOWER(?)`.
   - `rotateToken(teacherId, oldTokenHash, newTokenHash)`: atomically updates `token_hash = newTokenHash, claim_hash = NULL, claim_expires_at = NULL, token_rotated_at = ? WHERE id = ? AND token_hash = ? AND active = 1`. Returns boolean `rotated`.
   - `claimByCodeHash(claimHash, newTokenHash)`: finds teacher where `claim_hash = ? AND active = 1 AND (claim_expires_at IS NULL OR claim_expires_at > ?)`, atomically sets `token_hash = newTokenHash, claim_hash = NULL, claim_expires_at = NULL, token_rotated_at = ?`, and returns the updated teacher row (or `null`).
   - `setActive(teacherId, active)` and `adminResetToken(teacherId, newTokenHash, claimHash, claimExpiresAt)`.

---

### Component 2: Opaque Connection Capsules & Single-Use Claim Codes (`server/relay/auth.js` & `src/core/relay-config.js`)

End users should never see raw `?relay=https://...&token=64hex` parameters in links or settings.

#### [MODIFY] [server/relay/auth.js](file:///Users/mvanmierlo/Documents/kb-tools/server/relay/auth.js)
Add helpers for opaque connection capsules (`KBCON1.`) and human-friendly single-use claim codes (`KBC-XXXX-XXXX-XXXX`):
```js
export const CONNECT_CAPSULE_PREFIX = 'KBCON1.';

/**
 * Encode { r: relayUrl, t: token, id: teacherId } into an opaque URL-safe capsule
 */
export function encodeConnectCapsule({ relayUrl, token, teacherId }) {
  const payload = JSON.stringify({
    v: 1,
    r: String(relayUrl || '').replace(/\/+$/, ''),
    t: String(token || '').trim(),
    id: String(teacherId || '').trim()
  });
  return CONNECT_CAPSULE_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * Generate a 12-character Crockford Base32 one-time claim code (60 bits entropy): KBC-XXXX-XXXX-XXXX
 */
export function generateClaimCode() {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = randomBytes(12);
  let chars = '';
  for (let i = 0; i < 12; i++) chars += alphabet[bytes[i] & 31];
  return `KBC-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function normalizeClaimCode(code) {
  return String(code || '').toUpperCase().replace(/^KBC-?/i, '').replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
}
```

#### [MODIFY] [src/core/relay-config.js](file:///Users/mvanmierlo/Documents/kb-tools/src/core/relay-config.js)
Add client-side decoder `parseConnectionInput(input, fallbackRelayUrl)` that accepts:
1. A full `#/connect?c=KBCON1.<base64url>` link or bare `KBCON1.<base64url>` capsule.
2. A short claim code (`KBC-XXXX-XXXX-XXXX`) when `fallbackRelayUrl` is known (from `config.json` or the URL field).
3. Legacy `#/connect?relay=...&token=...` URLs (for backward compatibility).

---

### Component 3: Relay Server Endpoints for Key Rolling, Claim Codes, OIDC SSO & Co-Teacher Access (`server/relay/`)

#### [NEW] [server/relay/oidc.js](file:///Users/mvanmierlo/Documents/kb-tools/server/relay/oidc.js)
Zero-dependency OIDC `id_token` verifier using Web Standard `crypto.subtle` (compatible with both Cloudflare Workers and Node.js 20+):
- Supports Google (`https://accounts.google.com`, JWKS `https://www.googleapis.com/oauth2/v3/certs`) and Microsoft Entra ID (`https://login.microsoftonline.com/{tenant}/v2.0`, JWKS `https://login.microsoftonline.com/common/discovery/v2.0/keys`).
- Caches fetched JWKS keys in memory for 1 hour.
- Verifies RS256 signature, `exp` / `nbf` (with 60s clock skew tolerance), `aud` (must match configured `clientId`), and domain/tenant (`hd` for Google, `tid` for Microsoft).
- Returns `{ sub, email, email_verified, name, hd, tid }`.

#### [MODIFY] [server/relay/handler.js](file:///Users/mvanmierlo/Documents/kb-tools/server/relay/handler.js)
Add three authentication endpoints and fix co-teacher drop access:

1. **`POST /api/v1/auth/roll` (Automatic Single-Use Key Rolling):**
   - Rate-limited by client IP (`20/min`).
   - Extracts current `Bearer <token>` from `Authorization` header.
   - Looks up teacher by `hashToken(token)`. If not found $\rightarrow$ `401`. If `active === 0` $\rightarrow$ `403`.
   - Generates `newToken = generateToken()` and `newHash = hashToken(newToken)`.
   - Calls `await db.teachers.rotateToken(teacher.id, hashToken(token), newHash)`.
   - Returns `200 OK`:
     ```json
     {
       "ok": true,
       "token": "<new_64_hex_token>",
       "teacher_id": "T-101",
       "name": "Ms. Jansen",
       "bytes_used": 0,
       "quota_bytes": 1073741824
     }
     ```
   - Sets `Cache-Control: no-store`.

2. **`POST /api/v1/auth/claim` (Short One-Time Claim Code Exchange):**
   - Rate-limited strictly by client IP (`10/min`) to prevent brute-forcing.
   - Reads `{ code }` from JSON body, normalizes with `normalizeClaimCode(code)`, hashes with `hashToken(normalized)`.
   - Generates `newToken = generateToken()` and calls `await db.teachers.claimByCodeHash(claimHash, hashToken(newToken))`.
   - If no active, non-expired match $\rightarrow$ `401 Invalid or expired claim code`.
   - Returns `200 OK` with `{ ok: true, token: newToken, teacher_id, name, bytes_used, quota_bytes }` and `Cache-Control: no-store`.

3. **`POST /api/v1/auth/oidc` (School SSO Token Exchange):**
   - Enabled when `oidcConfig` is passed to `createRelayFetchHandler` (from `env.KB_OIDC_*` in `worker.js` or `process.env.KB_OIDC_*` in `index.js`).
   - Accepts `{ provider: 'google' | 'microsoft', id_token }`.
   - Verifies the JWT via `verifyOidcToken( { provider, idToken, oidcConfig } )`.
   - Looks up teacher by `await db.teachers.getByEmail(claims.email)`.
   - If not found and `oidcConfig.autoProvisionTeachers === true` (and `claims.email` matches allowed staff domain), creates the teacher record automatically (`id: 't_' + sha256(claims.email).slice(0, 12)`).
   - If teacher is deactivated (`active === 0`) $\rightarrow$ `403`.
   - Rotates and issues a fresh bearer token via `db.teachers.rotateToken`, returning `{ ok: true, token: newToken, teacher_id, name, bytes_used, quota_bytes }`.

4. **Expose Auth Capabilities on `GET /api/v1/health`:**
   - Include `auth_methods: ['roll', 'claim', ...(oidcEnabled ? ['oidc'] : [])]` and `oidc_providers: { google: Boolean(oidcConfig.googleClientId), microsoft: Boolean(oidcConfig.microsoftClientId) }` so the frontend knows whether OIDC SSO is enabled on the relay.

5. **Co-Teacher Drop Box Access Fix (`GET /drops/:dropId/submissions` & `GET /drops/:dropId/stats`):**
   - Currently lines 1214 & 1261 reject any teacher where `drop.teacher_id !== teacher.id`.
   - Update the check so access is granted if `drop.teacher_id === teacher.id || (drop.secret_hash && dropSecretOk(drop))`.
   - Update [`RelayTransport.listDrop`](file:///Users/mvanmierlo/Documents/kb-tools/src/core/transport.js#L240) to accept `{ since, after, limit, dropSecret }` and send `X-KB-Drop-Secret: dropSecret` when provided.

#### [MODIFY] [server/relay/worker.js](file:///Users/mvanmierlo/Documents/kb-tools/server/relay/worker.js) & [server/relay/index.js](file:///Users/mvanmierlo/Documents/kb-tools/server/relay/index.js) & [wrangler.toml](file:///Users/mvanmierlo/Documents/kb-tools/wrangler.toml)
- Wire `oidcConfig` from environment variables:
  - `KB_OIDC_GOOGLE_CLIENT_ID`, `KB_OIDC_GOOGLE_DOMAIN`
  - `KB_OIDC_MS_CLIENT_ID`, `KB_OIDC_MS_TENANT`
  - `KB_OIDC_AUTO_PROVISION` (`"true"` / `"false"`)

---

### Component 4: KeyVault Sealing of Relay Credentials (Zero Plaintext in IndexedDB or UI)

#### [MODIFY] [src/core/transport.js](file:///Users/mvanmierlo/Documents/kb-tools/src/core/transport.js)
Currently, `setTransportConfig(config)` writes `{ baseUrl, token, teacherId }` in plain text to `app_metadata.sync_config`.
Change this so the token is sealed inside `KeyVault`:
1. Define `export const RELAY_VAULT_SECRET = 'relay_credentials';`.
2. In `setTransportConfig(config)`:
   - Store the sensitive token encrypted inside `KeyVault`:
     ```js
     await KeyVault.setSecret(storage, RELAY_VAULT_SECRET, {
       baseUrl: cleanUrl,
       token: config.token || '',
       teacherId: config.teacherId || '',
       name: config.name || '',
       connectedAt: config.connectedAt || new Date().toISOString()
     });
     ```
   - In `app_metadata.sync_config`, store **only non-sensitive public metadata** (never the raw `token`):
     ```js
     await storage.setMetadata('sync_config', {
       baseUrl: cleanUrl,
       teacherId: config.teacherId || '',
       name: config.name || '',
       connectedAt: config.connectedAt || new Date().toISOString(),
       sealed: true
     });
     ```
3. In `getTransportConfig()` and `getTransport()`:
   - Read `sync_config` from `app_metadata` and read the decrypted token from `await KeyVault.getSecret(storage, RELAY_VAULT_SECRET)`.
   - **Auto-migration:** If an existing installation has a legacy plaintext `sync_config.token` in `app_metadata`, automatically migrate it into `KeyVault.setSecret(storage, RELAY_VAULT_SECRET, ...)` and strip `token` from `app_metadata.sync_config`!
   - **Bonus benefit:** Because `vault_secrets` is already included in encrypted v3 backups and QR device-link bundles (`KeyVault.exportLinkBundle`), a teacher's relay connection will now survive encrypted backup restores automatically while never sitting in plaintext!

---

### Component 5: Seamless Onboarding, Auto-Rolling & Zero-Plaintext Settings UI

#### [NEW] [src/core/relay-sso.js](file:///Users/mvanmierlo/Documents/kb-tools/src/core/relay-sso.js)
Client-side OIDC popup flow built on top of [`src/core/storage-adapters/oauth.js`](file:///Users/mvanmierlo/Documents/kb-tools/src/core/storage-adapters/oauth.js) (`openAuthPopup`, `redirectUri`, `randomString`):
- `signInWithSchoolSso({ provider, baseUrl, clientId, hostedDomain, tenant })`:
  - Opens Google or Microsoft OIDC authorization URL with `response_type=id_token`, `scope=openid email profile`, `redirect_uri=${redirectUri()}`, `state`, and `nonce`.
  - Receives `{ id_token }` from `oauth-callback.html` via `BroadcastChannel('kb-oauth')`.
  - Posts `{ provider, id_token }` to `${relayApiBase(baseUrl)}/auth/oidc`.
  - Saves the returned `{ baseUrl, token, teacherId, name }` via `setTransportConfig()`.

#### [MODIFY] [src/router.js](file:///Users/mvanmierlo/Documents/kb-tools/src/router.js) (`_handleConnectRoute`)
Upgrade `#/connect` to handle cross-origin single-use key rolling:
1. Immediately scrub the URL hash via `window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#/`)`.
2. Parse either `?c=KBCON1...` (opaque capsule) or legacy `?relay=...&token=...` via `parseConnectionInput`.
3. Prompt the teacher with `ConfirmDialog.show`:
   - Shows the relay origin (e.g. `https://kb-relay.school.workers.dev`) and Teacher ID, with **no raw token displayed**.
4. Call `rollOrVerifyRelayToken({ baseUrl, token })`:
   - Calls `POST ${apiBase}/auth/roll` with `Authorization: Bearer ${token}` to atomically rotate the key on the Cloudflare Worker and get back `{ token: rotatedToken, teacher_id, name }` (falls back to `GET /whoami` only if talking to an older v1 relay without `/auth/roll`).
   - If the request fails (e.g. link was already used once, token revoked, or CSP blocked), shows a clear actionable error via `explainRelayFailure` and does **not** overwrite existing valid credentials.
5. Seals the rotated token via `await setTransportConfig({ baseUrl, token: rotatedToken, teacherId, name })`, updates `teacher_profile` if needed, and navigates to `#/settings?section=relay`.

#### [MODIFY] [src/modules/settings/index.js](file:///Users/mvanmierlo/Documents/kb-tools/src/modules/settings/index.js) (`renderRelaySection`)
Redesign the *Settings → School Sync Server* tab so **no plaintext tokens are ever visible**:
1. **When Connected:**
   - Displays a clean **Connected** status card showing:
     - Server URL (`https://kb-relay...`), Teacher Name & ID (`Ms. Jansen · T-101`), Connection status badge, and Quota progress bar.
     - Action buttons: **"Test Connection & Quota"**, **"Rotate Security Key"** (calls `POST /api/v1/auth/roll` on demand and seals the new key in `KeyVault`), and **"Disconnect"**.
   - **Never** renders the bearer token into any input field or DOM attribute.
2. **When Disconnected (or Switching Server):**
   - Pre-fills the Relay Server URL from `window.KB_CONFIG?.relay?.baseUrl || window.KB_CONFIG?.baseUrl` automatically!
   - Provides three frictionless ways to connect:
     - **Option 1 (If SSO configured in `config.json`):** Prominent **"Sign in with Google Workspace"** / **"Sign in with Microsoft 365"** buttons.
     - **Option 2 (One-Time Claim Code or Connection Capsule):** A single masked input (`type="password"`, **without** `password-toggle` reveal) labeled **"Connection Code or Onboarding Link"** where a teacher can paste either a short claim code (`KBC-XXXX-XXXX-XXXX`) or a `KBCON1.` link.
     - Upon clicking **"Connect"**, the client exchanges/rolls the code with the relay server, seals the resulting token in `KeyVault`, and clears the input field immediately.

#### [MODIFY] [src/main.js](file:///Users/mvanmierlo/Documents/kb-tools/src/main.js)
- Remove the dead legacy dialog body in `openRelayConfigDialog` (lines 764–800) that previously rendered `<sl-input id="input-relay-token" password-toggle value="${currentConfig.token}">`, keeping only the clean redirect to `#/settings?section=relay`.

---

### Component 6: Cross-Origin CLI Provisioning & CSP Tooling (`scripts/`)

#### [MODIFY] [scripts/relay-init.mjs](file:///Users/mvanmierlo/Documents/kb-tools/scripts/relay-init.mjs) & [scripts/relay-add-teacher.mjs](file:///Users/mvanmierlo/Documents/kb-tools/scripts/relay-add-teacher.mjs)
Support the split **App Origin (Cloudflare Pages / GitHub Pages)** + **Relay Origin (Cloudflare Workers)** architecture:
1. Add `--app-url <url>` (or `KB_APP_PUBLIC_URL` env var) alongside `--public-url <relay-url>`:
   - `--public-url` is the Relay Server URL (e.g., `https://kennisboost-relay.school.workers.dev`).
   - `--app-url` is the Frontend Web App URL (e.g., `https://kb.myschool.edu` or `https://myschool.github.io/kb-tools`). Defaults to `--public-url` only when `--serve-app` is used.
2. Accept optional `email` column in `teachers.csv` (`id,name,email`) so schools using Google/Microsoft SSO can seed authorized teacher emails in one step.
3. For each teacher, generate:
   - An initial 32-byte setup token (`token_hash` stored in DB/D1 SQL).
   - A 12-character one-time claim code `KBC-XXXX-XXXX-XXXX` (`claim_hash` stored in DB/D1 SQL, valid for 30 days).
   - An opaque `#/connect?c=KBCON1.<base64url>` onboarding URL pointing to `${appUrl}/#/connect?c=KBCON1...` (so no raw `token=` or `relay=` appears in the link).
4. Add `--rotate <teacherId>` and `--deactivate <teacherId>` flags to `scripts/relay-add-teacher.mjs` (or a new script `scripts/relay-manage-teacher.mjs`) so IT admins can revoke a teacher or issue a new claim code for both local SQLite and Cloudflare D1.

#### [MODIFY] [scripts/csp.mjs](file:///Users/mvanmierlo/Documents/kb-tools/scripts/csp.mjs)
Ensure static deployments on Cloudflare Pages (`_headers`) and GitHub Pages (`<meta http-equiv="Content-Security-Policy">` in `index.html`) allow the cross-origin relay and OIDC endpoints:
- In `CLOUD_ORIGINS.google`, include `https://oauth2.googleapis.com` and `https://www.googleapis.com` (popup navigation to `accounts.google.com` is a top-level window navigation, not subject to `connect-src`, and returns to `oauth-callback.html`).
- Ensure `configOrigins()` in `scripts/csp.mjs` reads `config.json`'s `relay.baseUrl` so running `npm run csp` (or `npm run build`) before deploying to GitHub Pages / Cloudflare Pages bakes the Cloudflare Worker origin directly into `index.html`'s `<meta>` CSP tag and `_headers`.

---

## 4. Verification Plan

### Automated Tests
The executing agent must run `npm test` (Vitest) and add comprehensive test suites covering all new flows:

1. **Unit & Integration Test Suite (`tests/phase45-relay-auth-security.test.js`):**
   - **Schema v4 & Migration Test:** Verify both `createDatabase(':memory:')` (`db.js`) and `createD1Database(mockD1)` (`d1-db.js`) migrate v3 tables to v4 (`email`, `claim_hash`, `claim_expires_at`, `active`, `token_rotated_at`).
   - **Single-Use Key Rolling (`POST /api/v1/auth/roll`):**
     - Verify calling `/api/v1/auth/roll` with initial token `T_init` returns a new token `T_new` (`T_new !== T_init`).
     - Verify a second call with `T_init` immediately returns `401 Unauthorized` (replay protection).
     - Verify `GET /api/v1/whoami` with `T_new` succeeds.
   - **Short Claim Code Exchange (`POST /api/v1/auth/claim`):**
     - Verify claiming `KBC-XXXX-XXXX-XXXX` returns a valid bearer token and burns `claim_hash` so a second attempt returns `401`.
     - Verify expired `claim_expires_at` or `active = 0` teacher is rejected.
   - **OIDC Token Verification (`POST /api/v1/auth/oidc`):**
     - Generate an ephemeral RSA-2048 keypair in the test using `crypto.subtle`, sign a mock OIDC `id_token` JWT for Google and Microsoft, mock the JWKS fetch, and verify:
       - Matching domain + registered teacher email succeeds and returns a fresh bearer token.
       - Wrong `hd` / `tid`, expired JWT, or unlisted student email returns `403`.
   - **KeyVault Credential Sealing & Legacy Migration:**
     - Verify `setTransportConfig({ baseUrl, token, teacherId })` encrypts `token` inside `KeyVault` (`vault_secrets.relay_credentials`) and that `storage.getMetadata('sync_config')` does **not** contain a `token` property in plaintext.
     - Verify legacy plaintext `sync_config.token` is automatically migrated into `KeyVault` and scrubbed from `app_metadata` on first read.
   - **Zero Plaintext in DOM & Cross-Origin `#/connect` Flow:**
     - Render `#/settings?section=relay` when connected and assert `container.innerHTML` does **not** contain the bearer token string or any `password-toggle` input holding the token.
     - Simulate navigating to `#/connect?c=KBCON1...` where App origin is `https://kb.pages.dev` and Relay origin is `https://kb-relay.workers.dev`; verify URL bar is scrubbed, `/api/v1/auth/roll` is called on the Worker origin, and the rotated token is sealed in `KeyVault`.
   - **Co-Teacher Drop Box Access:**
     - Verify Teacher B (co-teacher) can call `GET /api/v1/drops/:dropId/submissions` with Teacher B's bearer token + `X-KB-Drop-Secret` header and receive `200 OK`, while Teacher C (without `X-KB-Drop-Secret`) gets `403 Forbidden`.

2. **Full Existing Test Suite & Service Worker Manifest Check:**
   ```bash
   npm run build:sw
   npm test
   ```
   Ensure all existing security, CSP, replication, and D1 parity tests pass with 0 failures.
