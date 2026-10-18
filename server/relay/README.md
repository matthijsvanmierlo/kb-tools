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
   - Student submissions (`KBSUB1.`) are encrypted end-to-end to the teacher's key using secp256k1 ECIES + AES-GCM before posting.
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

## API Routes (`/api/v1`)

| Method | Path | Auth | Body / Query | Description |
|---|---|---|---|---|
| GET | `/health` | None | — | Health check & capabilities |
| POST | `/payloads` | Teacher | `{ kind, ciphertext, expires_at, meta }` | Store encrypted short link payload (max 512KB) |
| GET | `/payloads/:ref` | None | — | Retrieve encrypted lesson payload |
| POST | `/drops` | Teacher | `{ assignment_id, publish_version, expires_at }` | Create submission drop box |
| POST | `/drops/:dropId/submissions` | None | Raw `KBSUB1.` envelope (text/plain) | Submit student work (rate-limited, max 256KB) |
| GET | `/drops/:dropId/submissions?since=<iso>` | Teacher | — | List submissions for a drop box |
| DELETE | `/drops/:dropId` | Teacher | — | Delete drop box and submissions |
