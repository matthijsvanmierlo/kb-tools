# Relay Server: Deployment Options & Security Architecture

This document outlines the hosting options, operational deployment patterns, and credential security model for the **Node.js + SQLite Kennisboost Relay Server**.

---

## 1. Executive Summary & Core Security Principles

1. **Persistent Storage Requirement:**
   - The relay uses **Node.js** with **SQLite in WAL mode** (`better-sqlite3` / `sqlite3`).
   - The SQLite database file (`relay.sqlite`) **must reside on a persistent disk or volume**. Ephemeral serverless hosts (standard Vercel/Netlify functions) are unsuitable for the SQLite model because redeploys wipe local storage.
2. **Zero-Leak Client Model (Students):**
   - **All ~1,300 students receive and store 0 credentials or tokens.**
   - All student communication (`GET /feed/:id`, `POST /submissions`, `PUT /drafts`) occurs over unauthenticated public endpoints.
   - Payloads are **end-to-end encrypted** client-side using the course access code or teacher public key. The relay server is purely a blind ciphertext broker.
3. **Controlled Teacher Model (~200 Teachers):**
   - Teachers authenticate using cryptographic bearer tokens (`Authorization: Bearer <token>`).
   - The relay server **never stores raw tokens**—only `SHA-256(token)` hashes.
   - Token distribution is automated and sanitized via browser URL hash fragments (`#`), preventing network or history leaks.

---

## 2. Platform Deployment Options

| Metric / Feature | Option A: Cloud Linux VPS | Option B: Cloudflare Edge (Workers + D1 + R2) | Option C: On-Premises + Cloudflare Tunnel | Option D: PaaS Container + Volume |
| :--- | :--- | :--- | :--- | :--- |
| **Providers** | Hetzner Cloud, DigitalOcean, Linode | Cloudflare | Raspberry Pi 4/5, School PC + `cloudflared` | Render, Railway, Fly.io |
| **Typical Cost** | ~$3.50 – $5.00 / month | **$0.00 / month (Free Tier)** | **$0.00 / month** (zero cloud bills) | $0 (Free) to $5–$7 / month |
| **Persistence** | Native NVMe/SSD drive | Cloudflare D1 (Serverless SQLite) + R2 | Local SSD / SD card | Persistent Volume Mount |
| **Setup Overhead** | Low (script + Caddy) | Low (wrangler deploy) | Very Low (single daemon command) | Very Low (Git push deploy) |
| **HTTPS / TLS** | Automatic via Caddy | Automatic & instant at Edge | Automatic via Cloudflare Edge | Automatic (built into platform) |
| **Firewall / Port Forwarding** | Port 80/443 open | None (Managed Edge) | **None required (Outbound only)** | None (Managed PaaS) |
| **Maintenance** | OS updates + backups | **Zero maintenance / Serverless** | Occasional local device check | Container updates |

---

### Option A: Cloud Linux VPS (Hetzner / DigitalOcean)

A robust traditional configuration for teams comfortable with a minimal Linux environment.

#### System Architecture:
```
[Students & Teachers] 
       │  (HTTPS / 443)
       ▼
 [ Caddy Reverse Proxy ]  <-- Automatic TLS certificates (Let's Encrypt / ZeroSSL)
       │  (HTTP / localhost:8000)
       ▼
 [ Node.js Relay Service ] (managed by systemd or pm2)
       │
       ▼
 [ relay.sqlite ] (NVMe / SSD in WAL mode)
```

#### Provisioning Steps:
1. **Provision VM:** Ubuntu 24.04 LTS (1 vCPU, 2 GB RAM, 20–40 GB NVMe).
2. **Clone & Install:**
   ```bash
   cd /var/www/kb-tools
   npm ci --production
   npm run relay:init
   ```
3. **Setup Caddy (`/etc/caddy/Caddyfile`):**
   ```caddy
   relay.yourdomain.com {
       encode zstd gzip
       reverse_proxy localhost:8000
   }
   ```
4. **Setup `systemd` Service (`/etc/systemd/system/kb-relay.service`):**
   ```ini
   [Unit]
   Description=Kennisboost Relay Service
   After=network.target

   [Service]
   Type=simple
   User=www-data
   WorkingDirectory=/var/www/kb-tools
   Environment=PORT=8000
   Environment=NODE_ENV=production
   Environment=KB_RELAY_DB=/var/www/kb-tools/relay.sqlite
   ExecStart=/usr/bin/node src/relay-server.mjs
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

---

### Option B: Cloudflare Edge (Workers + D1 + R2) — *Pure Cloud Hosting & Free Tier*

Cloudflare provides a 100% serverless edge platform that replicates the exact relay database and media offloading architecture without any virtual machines.

#### Architecture Mapping:
```
[Students & Teachers] 
       │  (HTTPS / Anycast Edge in 300+ cities)
       ▼
 [ Cloudflare Worker ]  <-- Lightweight TypeScript/JS router (e.g. Hono framework)
       │
       ├──► Cloudflare D1 (Serverless SQLite database: schemas, drops, teachers, drafts)
       └──► Cloudflare R2 (S3-compatible object storage: encrypted media & submissions)
```

#### Why it fits this workload:
1. **D1 is Native SQLite:** Under the hood, D1 runs SQLite. All schemas (`payloads`, `drops`, `submissions`, `teachers`, `drafts`) execute native SQLite SQL commands.
2. **Zero Hosting Bills (Generous Free Quotas):**
   - **Cloudflare Workers:** 100,000 requests/day free (far exceeds daily volume of 200 teachers + 1,300 students).
   - **Cloudflare D1:** 5 GB storage free + 5 million rows read/day free.
   - **Cloudflare R2:** 10 GB storage free + **$0.00 egress/bandwidth fees forever** (unlike AWS S3 or GCP which charge heavily for student media downloads).
3. **Zero Maintenance:** No Linux OS to patch, no disks running out of space, no daemon crashes, and DDoS attack protection included by default.

#### Deployment Setup (`wrangler.toml`):
```toml
name = "kennisboost-relay"
main = "src/worker.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "kennisboost-relay-db"
database_id = "<your-d1-uuid>"

[[r2_buckets]]
binding = "MEDIA_BUCKET"
bucket_name = "kennisboost-media"
```

---

### Option C: On-Premises Node.js + Cloudflare Tunnel (`cloudflared`) — *Zero Monthly Bills & 100% Privacy*

If you want to run the exact existing Node.js code as-is without rewriting anything, but want **$0 monthly cloud bills** and **no port forwarding on the school firewall**:

#### Architecture:
```
[Students / Teachers on Internet or LAN]
       │  (HTTPS to https://relay.myschool.edu)
       ▼
 [ Cloudflare Global Edge ]  <-- Handles SSL, DDoS protection, edge caching
       │  (Encrypted outbound tunnel — NO INBOUND PORTS OPEN)
       ▼
 [ cloudflared daemon ]       <-- Runs as a lightweight service on the local device
       │  (localhost:8000)
       ▼
 [ Node.js Relay Server + relay.sqlite ] (Running on a Raspberry Pi 4/5, Mac Mini, or school PC)
```

#### Why this is ideal for schools:
1. **No Open Ports or Static IP:** Most school firewalls and home routers block inbound port 80/443 or use CGNAT. A Cloudflare Tunnel establishes a persistent **outbound-only** connection to Cloudflare’s nearest edge. No network admin approval needed for opening firewall ports.
2. **Zero Cloud Hosting Costs:** The hardware is already paid for; Cloudflare Tunnels are completely free with any domain.
3. **100% Local Data Sovereignty:** The encrypted database and files stay inside the school building.
4. **Cloudflare Zero Trust / Access Integration:** You can protect teacher routes (`/drops`, `/sync`) with Google or Microsoft 365 school accounts directly at the Cloudflare edge in two clicks.

#### Quick Setup:
1. Start your local relay as normal:
   ```bash
   PORT=8000 npm run relay
   ```
2. Download and authenticate `cloudflared` (available on Mac, Windows, Linux, Raspberry Pi OS):
   ```bash
   cloudflared tunnel create kb-relay
   ```
3. Configure `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <your-tunnel-uuid>
   credentials-file: /root/.cloudflared/<your-tunnel-uuid>.json

   ingress:
     - hostname: relay.yourdomain.com
       service: http://localhost:8000
     - service: http_status:404
   ```
4. Route DNS and start the tunnel:
   ```bash
   cloudflared tunnel route dns kb-relay relay.yourdomain.com
   cloudflared tunnel run kb-relay
   ```

---

### Option D: PaaS Container with Volume Mount (Render / Railway / Fly.io)

For teams wanting a managed Docker/PaaS environment:

1. **Volume Configuration:**
   - Create an attached disk volume (e.g. 5 GB mounted at `/data`).
2. **Environment Variables:**
   - `PORT=8000`
   - `KB_RELAY_DB=/data/relay.sqlite`
   - `NODE_ENV=production`
3. **Startup Command:**
   ```bash
   node src/relay-server.mjs
   ```
> [!WARNING]
> Without an attached volume mount, any git push or container restart will wipe the ephemeral storage and destroy the SQLite database!

---

## 3. Credential Security & Zero-Leak Client Distribution

### 3.1 The Role Breakdown

```
                    ┌────────────────────────────┐
                    │      Kennisboost Relay     │
                    └──────────────┬─────────────┘
                                   │
         ┌─────────────────────────┴─────────────────────────┐
         ▼                                                   ▼
┌───────────────────┐                               ┌───────────────────┐
│     STUDENTS      │                               │     TEACHERS      │
│  (1,300 Clients)  │                               │   (200 Clients)   │
├───────────────────┤                               ├───────────────────┤
│ • 0 credentials   │                               │ • 1 Bearer Token  │
│ • 0 accounts      │                               │ • Stored hashed   │
│ • End-to-end enc. │                               │ • Controls drops  │
│ • Public routes   │                               │ • Controls feeds  │
└───────────────────┘                               └───────────────────┘
```

---

### 3.2 Distributing Teacher Tokens Without Leakage

#### Strategy 1: URL Hash Fragments (`#`) with Auto-Sanitization (Recommended)
Distribute a private onboarding link to each teacher (via school staff email or HR portal):
```text
https://app.kennisboost.nl/#/connect?relay=https://relay.yourdomain.com&token=t_8f3a9b1c72...&id=T-102
```

**Why this prevents credential leakage:**
1. **RFC 3986 Compliance:** Browsers **never** send anything following `#` across the network. Web servers, reverse proxies, and ISP logs never see the token.
2. **Immediate Address Bar Scrubbing:**
   ```javascript
   // Upon opening the link in the client:
   const hash = window.location.hash;
   if (hash.startsWith('#/connect')) {
     const params = new URLSearchParams(hash.slice(hash.indexOf('?')));
     const token = params.get('token');
     const relayUrl = params.get('relay');

     if (token && relayUrl) {
       await saveTeacherRelayConfig({ token, relayUrl });
       // Scrub the token immediately from browser history and URL bar:
       window.history.replaceState({}, document.title, window.location.pathname);
     }
   }
   ```
3. The token is stored locally inside the teacher's browser IndexedDB (`sync_config`) and wiped from URL memory in milliseconds.

---

#### Strategy 2: Server-Side Token Hashing
If the relay server's disk or backup is ever compromised, plain-text teacher credentials are safe because the server only stores hashes:
```sql
CREATE TABLE teachers (
    teacher_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,    -- SHA-256 hash of the bearer token
    active INTEGER DEFAULT 1,
    created_at INTEGER
);
```

**Validation Logic on Incoming Requests:**
```javascript
const authHeader = req.headers['authorization'] || '';
const match = authHeader.match(/^Bearer\s+([a-zA-Z0-9_\-]+)$/i);
if (!match) return res.status(401).json({ error: 'Missing or malformed token' });

const incomingToken = match[1];
const incomingHash = crypto.createHash('sha256').update(incomingToken).digest('hex');

const teacher = db.prepare('SELECT * FROM teachers WHERE token_hash = ? AND active = 1').get(incomingHash);
if (!teacher) return res.status(403).json({ error: 'Invalid or deactivated token' });
```

---

#### Strategy 3: School SSO / Identity-Aware Proxy (Alternative)
For schools using Google Workspace or Microsoft 365:
- Place the relay behind **Cloudflare Access** or **Google Workspace IAP**.
- Route rules:
  - `/api/v1/feed/*`, `/drops/*/submissions`, `/drops/*/drafts` $\rightarrow$ Open / Bypass (Public for students).
  - `/drops`, `/payloads`, `/sync/*` $\rightarrow$ Enforce login with `@school.edu` Google/Microsoft credentials.
- In this model, teachers manage **no tokens at all**. Authentication is handled entirely by school SSO.

---

## 4. Operational Checklist for Production Launch

1. [ ] **Initialize Server:** Run `npm run relay:init` to build the database schema and WAL configuration.
2. [ ] **Batch Provision Teachers:** Run `node scripts/relay-add-teacher.mjs --csv staff.csv` to generate initial tokens and insert SHA-256 hashes.
3. [ ] **Configure Reverse Proxy:** Ensure Caddy or Nginx proxies port 8000 and terminates TLS.
4. [ ] **Set Retention Purge Cron:** Schedule daily cleanup for expired drafts and drops:
   ```bash
   0 3 * * * node /var/www/kb-tools/scripts/relay-prune-stale.mjs
   ```
5. [ ] **Verify Client Gating:** Ensure client apps without configured relays function normally in offline mode without attempting unnecessary network calls.
