# KennisBoost Reference Relay Server

A lightweight, zero-dependency, self-hostable HTTP relay and drop box server built exclusively with Node.js built-ins (`node:http`, `node:sqlite`, `node:crypto`).

## Overview

The KennisBoost relay server provides:
- **Hosted Payloads (Short Links):** Stores opaque encrypted lesson blobs. The AES-256-GCM decryption key stays in the URL fragment (`#`) and is **never** sent to the server.
- **Server-Assisted Hand-in (Drop Boxes):** Enables students to submit work with one click directly from the assessment screen without downloading `.kbsub` files manually. Submissions are encrypted with ECIES to the teacher's personal public key before transmission.

## Security Architecture & Threat Model

1. **Zero-Knowledge by Design:**
   - The relay server **never** sees plaintext lessons or student work.
   - Lesson payloads are encrypted client-side with ephemeral random keys placed in the URL fragment (`k=<key>`). The browser does not send hash fragments over HTTP.
   - Student submissions (`KBSUB1.`) are encrypted end-to-end to the teacher's key using ECIES (ECDH P-256 + HKDF-SHA-256) with AES-256-GCM before posting.
2. **Visible Metadata:**
   - The server records drop box assignment IDs, timestamps, submission envelope lengths, and client IP addresses (used solely for rate limiting).
   - If metadata titles are provided during publish, they are stored alongside the payload reference.
3. **Storage Security:**
   - SQLite backups (`relay.sqlite`) are safe to archive and store since all payload and submission content rows are encrypted blobs.
4. **Production Deployment:**
   - Always run behind an HTTPS reverse proxy (e.g., Caddy, Nginx, or Cloudflare Tunnel) to protect bearer tokens and in-transit submission envelopes.
   - Restrict `KB_RELAY_ORIGINS` to your school's domain (e.g., `https://kennisboost.myschool.edu`).

## Quickstart

### 1. Start the Relay Server

```bash
npm run relay
```

By default, the server runs on port `3000` and creates an SQLite database at `./data/relay.sqlite`.

### 2. Provision a Teacher Account

```bash
npm run relay:add-teacher "Teacher-101" "Ms. Smith"
```

This outputs a 64-character bearer token. Add this configuration to your local `config.js` or through the client application settings:

```js
window.KB_CONFIG = {
  baseUrl: 'http://localhost:3000',
  token: 'YOUR_SECRET_TOKEN',
  teacherId: 'Teacher-101'
};
```

## Running on a school network

The relay runs well on a small always-on machine inside the school (a spare PC, a VM or a
Raspberry Pi with Node.js 22.13+). It needs no `npm install` and no Docker. Because it only ever
stores ciphertext, hosting it is low risk. With the relay on the local network, hand-in, short links,
student drafts and multi-device sync keep working when the internet connection is down (the app
itself is cached on every device as a PWA).

1. **Set it up**:

   ```bash
   npm run relay:init -- --teacher "T1:Ms. Jansen" --teacher "T2:Mr. de Vries" \
     --public-url https://kb.school.lan --serve-app \
     --tls-cert /etc/ssl/certs/kb.pem --tls-key /etc/ssl/private/kb.key
   ```

   This creates `relay-deploy/` with the database, `relay.env` (settings) and
   `teacher-tokens.csv` (one private token per teacher; hand them out individually). Use
   `--teachers-csv teachers.csv` (columns `id,name`) for many teachers. Re-running adds new
   teachers and leaves existing tokens alone.

2. **Start it at boot**: copy `kennisboost-relay.service.example` to
   `/etc/systemd/system/kennisboost-relay.service`, adjust the paths, then
   `sudo systemctl enable --now kennisboost-relay`.

3. **HTTPS is required.** Browsers only allow service workers, the camera (QR scanning) and
   cross-origin requests from secure origins. Options, simplest first:
   - **A certificate for an internal name** (`kb.school.lan`) from your school's internal CA, if
     managed devices already trust it. Point `KB_RELAY_TLS_CERT` / `KB_RELAY_TLS_KEY` at it.
   - **Let's Encrypt with a DNS challenge** for a real subdomain that resolves to the LAN address
     (e.g. `kb.myschool.edu → 10.0.0.20`). The DNS-01 challenge works without opening any ports,
     e.g. `certbot certonly --dns-<provider> -d kb.myschool.edu`.
   - **A reverse proxy** you already run (Caddy, nginx, IIS) terminating TLS and forwarding to the
     relay's port.

4. **One origin is easiest.** With `--serve-app` (`KB_RELAY_SERVE_APP=1`) the relay also serves the
   KennisBoost app, so the app and the relay share an origin and the Content Security Policy needs
   no changes. Teachers then connect to the same URL they open the app from.

5. **Teachers connect** under *Backup & storage → Connect to a school server* with the URL and their
   token. Student devices need nothing: the relay address travels inside each published assignment.

### Privacy and retention

- Submissions, drafts and sync data are end-to-end encrypted before they reach the relay.
- The relay stores no IP addresses. Rate limiting keys clients by a salted hash that only lives
  in memory for the length of the rate-limit window.
- `KB_RELAY_RETENTION_DAYS` (default 180) deletes submissions, student drafts and sync chunks older
  than that. Each device's sync snapshot is kept, so devices can always catch up. Set it to `0`
  to keep everything.
- Each drop box gets a secret that students' devices send in a header (it is part of the
  published assignment). Drop ids appear in the teacher's listing URLs, but the secret never
  appears in a URL, so knowing an id is not enough to post to a drop box.

### Direct transfers without a server

When there is no relay, or for large work, a student can also send a submission straight to the
teacher's device (Inbox → *Receive directly*), and a teacher can copy all their data to a new
device (*Devices & sharing → Send your data to a nearby device*). These use a WebRTC connection set
up by scanning two codes, with no STUN/TURN servers, so nothing leaves the local network. Many
school Wi-Fi networks isolate clients from each other; then the app says so and suggests the
other ways.

## Content Security Policy

The app's CSP only allows network requests to its own origin (`connect-src 'self'`). If the relay
runs on a different origin than the app, allow it explicitly:

- bundled server: `KB_RELAY_ORIGIN=https://relay.myschool.edu npm start`
- static hosting: `KB_RELAY_ORIGIN=https://relay.myschool.edu npm run csp`, which regenerates the
  `<meta>` tag and `_headers` with the relay allowed (then `npm run build:sw` and deploy).

The "Connect to a school server" dialog tells teachers when a relay is blocked by the CSP.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` or `KB_RELAY_PORT` | `3000` | Port for the HTTP server |
| `KB_RELAY_DB` | `./data/relay.sqlite` | SQLite database file path (or `:memory:`) |
| `KB_RELAY_ORIGINS` | `*` | Comma-separated list of allowed CORS origins |
| `KB_RELAY_HOST` | all interfaces | Address to listen on |
| `KB_RELAY_RETENTION_DAYS` | `180` | Delete submissions, drafts and sync chunks older than this (`0` keeps all) |
| `KB_RELAY_TLS_CERT` / `KB_RELAY_TLS_KEY` | unset | PEM files; when both are set the relay serves HTTPS |
| `KB_RELAY_SERVE_APP` | unset | `1` also serves the KennisBoost app (same origin as the relay) |
| `KB_MEDIA_SIGNING_SECRET` | auto-generated | Secret key for HMAC-signed media upload URLs (persisted in DB) |
| `KB_CDN_ENDPOINT` | unset | S3-compatible endpoint for media CDN offloading (Cloudflare R2, MinIO, S3) |
| `KB_CDN_BUCKET` | unset | Bucket name for media assets |
| `KB_CDN_ACCESS_KEY_ID` | unset | S3 Access Key ID |
| `KB_CDN_SECRET_ACCESS_KEY` | unset | S3 Secret Access Key |
| `KB_CDN_REGION` | `auto` | S3 region |
| `KB_CDN_PUBLIC_URL` | unset | Public base URL for CDN media retrieval |
| `KB_CDN_LOCAL_DIR` | unset | Local directory for storing media files when using direct FS storage |

## API Routes (`/api/v1`)

| Method | Path | Auth | Body / Query | Description |
|---|---|---|---|---|
| GET | `/health` | None | — | Health check & capabilities |
| POST | `/media/presign` | Teacher | `{ sha256, mime, ext, size }` | Request HMAC-signed upload URL for media asset |
| POST | `/drops/:dropId/media/presign` | Drop secret | `{ sha256, mime, ext, size }` | Request HMAC-signed upload URL for student file attachment (max 25MB, drop quota enforced) |
| PUT | `/media/upload?key=&exp=&sig=[&drop_id=]` | HMAC sig | Raw binary | Upload media asset (verifies signature, expiry, and body SHA-256 match) |
| GET | `/media/file/:filename` | None | — | Download immutable media asset |
| POST | `/payloads` | Teacher | `{ kind, ciphertext, expires_at, meta }` | Store encrypted short link payload (max 512KB) |
| GET | `/payloads/:ref` | None | — | Retrieve encrypted lesson payload |
| POST | `/drops` | Teacher | `{ assignment_id, publish_version, expires_at }` | Create submission drop box; returns `{ drop_id, drop_secret }` |
| POST | `/drops/:dropId/submissions` | Drop secret | Raw `KBSUB1.` envelope (text/plain) | Submit student work (rate-limited, max 256KB). Header `X-KB-Drop-Secret` (drops created before secrets existed accept submissions without it) |
| GET | `/drops/:dropId/submissions?since=<iso>` | Teacher | — | List submissions for a drop box |
| DELETE | `/drops/:dropId` | Teacher | — | Delete drop box and submissions |
| PUT | `/drops/:dropId/drafts/:draftId` | Drop secret | Raw `KBDRAFT1.` ciphertext (text/plain) | Save a student's encrypted draft (64-hex id derived from their access code; max 256KB) |
| GET | `/drops/:dropId/drafts/:draftId` | Drop secret | — | Load that draft |
| POST | `/sync` | Teacher | — | Create a sync workspace; returns `{ workspace_id, workspace_key }` |
| POST | `/sync/:ws/chunks` | Teacher + workspace key | `{ device_id, start, end, body }` | Store an encrypted change chunk (idempotent, max 4MB) |
| GET | `/sync/:ws/chunks?after=<seq>` | Teacher + workspace key | — | List chunks after a server sequence (`{ items, more }`) |
| DELETE | `/sync/:ws/chunks?device_id=&through=` | Teacher + workspace key | — | Prune a device's chunks covered by its snapshot |
| PUT | `/sync/:ws/snapshots/:deviceId` | Teacher + workspace key | `{ created_at, body }` | Replace a device's encrypted snapshot (max 32MB) |
| GET | `/sync/:ws/snapshots[/:deviceId]` | Teacher + workspace key | — | List snapshots / fetch one |

### Sync workspaces

Multi-device sync and co-teaching (`src/core/replication/`) use workspaces. The workspace key is
sent as the `X-KB-Workspace-Key` header and stored only as a SHA-256 hash. Any teacher with a token
on this relay **and** the workspace key can read and write it: that is how a co-teacher joins a
shared class. Chunk and snapshot bodies are AES-256-GCM ciphertext under a key the relay never
sees; the relay learns only sizes, timestamps and opaque device ids.
