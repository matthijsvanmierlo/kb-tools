# Step-by-Step Guide: Deploy Kennisboost Relay to Cloudflare

This guide walks you through deploying the Kennisboost Relay Server to Cloudflare using **Cloudflare Workers** (Compute), **Cloudflare D1** (Serverless SQLite), and **Cloudflare R2** (Zero-egress Object Storage).

This setup runs within Cloudflare's **free tier** ($0.00/month) for ~200 teachers and ~1,300 students with zero servers or operating systems to maintain. The codebase now provides a **single shared core** powering both local Node.js and Cloudflare Workers out of the box!

---

## Prerequisites
- A free [Cloudflare Account](https://dash.cloudflare.com/sign-up).
- Node.js (v18 or newer) installed on your machine.

---

## Step 1: Install Wrangler & Log In

In your terminal, authenticate the Cloudflare CLI:

```bash
# Log in to Cloudflare (opens your browser to approve)
npx wrangler login
```

Verify your authentication:
```bash
npx wrangler whoami
```

---

## Step 2: Create Your Cloudflare D1 (SQLite) Database

Run this command to create your serverless SQLite database on Cloudflare:

```bash
npx wrangler d1 create kb-relay-db
```

The terminal will output a configuration block similar to this:
```toml
[[d1_databases]]
binding = "DB"
database_name = "kb-relay-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```
> [!IMPORTANT]
> Copy your `database_id` value—you will paste it into `wrangler.toml` in Step 4.

---

## Step 3: (Optional) Create R2 Bucket for Media

If you plan to offload audio and flashcard images to Cloudflare R2:

```bash
npx wrangler r2 bucket create kb-relay-media
```

---

## Step 4: Configure `wrangler.toml`

Open the existing `wrangler.toml` in the project root. Uncomment and set your `database_id`:

```toml
name = "kennisboost-relay"
main = "server/relay/worker.js"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[triggers]
crons = ["0 3 * * *"]

[[d1_databases]]
binding = "DB"
database_name = "kb-relay-db"
database_id = "YOUR_DATABASE_ID_FROM_STEP_2"

# Optional: uncomment if you created the R2 bucket in Step 3
# [[r2_buckets]]
# binding = "MEDIA_BUCKET"
# bucket_name = "kb-relay-media"

[vars]
KB_RELAY_ORIGINS = "*"
KB_RELAY_RETENTION_DAYS = "180"
```

---

## Step 5: Initialize the Database Schema

Apply the canonical database schema directly from `server/relay/schema.sql` with one command:

```bash
# Option A: via npm script
npm run relay:cf:schema

# Option B: via wrangler directly
npx wrangler d1 execute kb-relay-db --remote --file=./server/relay/schema.sql
```

---

## Step 6: Test Locally with Wrangler Dev

You can test the entire Cloudflare stack (Worker + D1 SQLite) on your local machine:

```bash
npm run relay:cf:dev
```

Cloudflare spins up a local server at `http://localhost:8787` with an in-memory SQLite database matching D1.

Test the health check in another terminal:
```bash
curl http://localhost:8787/api/v1/health
# {"ok":true,"version":"1.1.0","features":["payloads","drops","drafts","sync","feeds"]}
```

---

## Step 7: Deploy to Cloudflare Edge

Deploy to production across Cloudflare's global edge:

```bash
npm run relay:cf:deploy
```

Within a few seconds, Wrangler prints your live HTTPS URL:
```text
Deployed kennisboost-relay
https://kennisboost-relay.<your-subdomain>.workers.dev
```

---

## Step 8: Provision Teachers & Generate One-Click Onboarding Links

You have two easy ways to provision teachers:

### Option A: Batch Provision All Teachers via CSV (Recommended)
Create a `teachers.csv` with `id,name` columns, then run:

```bash
npm run relay:init -- --teachers-csv teachers.csv --public-url https://kennisboost-relay.<your-subdomain>.workers.dev --dir ./relay-deploy
```

This single command generates:
1. `relay-deploy/teacher-tokens.csv` with private one-click `#/connect` URLs for each teacher.
2. `relay-deploy/d1-seed-teachers.sql` with SQL insert statements containing the hashed tokens.

Apply the teachers to Cloudflare D1 in one command:
```bash
npx wrangler d1 execute kb-relay-db --remote --file=./relay-deploy/d1-seed-teachers.sql
```

### Option B: Add a Single Teacher via CLI
```bash
KB_RELAY_PUBLIC_URL=https://kennisboost-relay.<your-subdomain>.workers.dev npm run relay:add-teacher T-101 "Ms. Jansen"
```
The command outputs:
- A one-click onboarding URL (`https://app.kennisboost.nl/#/connect?relay=...&token=...&id=T-101`).
- The direct Cloudflare D1 SQL command to insert the hashed token.

---

## Step 9: Zero-Leak Teacher Onboarding UX

When a teacher opens their private one-click link:
```text
https://app.kennisboost.nl/#/connect?relay=https://kennisboost-relay.<your-subdomain>.workers.dev&token=t_8f3a9b1c...&id=T-101
```
1. The app stores the credentials in secure browser IndexedDB.
2. The URL fragment (`#...`) is **immediately wiped** from the browser's address bar and history via `window.history.replaceState`.
3. The server only ever holds the `SHA-256` hash of the token.
4. Students carry **0 tokens or credentials** and communicate over end-to-end encrypted public routes.

---

## Summary of Costs & Quotas

- **Monthly Cost:** **$0.00**
- **Requests:** 100,000 / day free (School estimated usage: ~25,000 / day).
- **Database Storage:** 5 GB free (School estimated usage: ~100 MB).
- **Media Egress Bandwidth:** **$0.00 forever** with Cloudflare R2.
