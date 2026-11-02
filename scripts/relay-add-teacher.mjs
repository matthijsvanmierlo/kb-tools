#!/usr/bin/env node
/**
 * Add or manage teacher accounts on the KennisBoost relay server.
 * Supports split-hosting architectures (e.g. App on Cloudflare/GitHub Pages, Relay on Cloudflare Worker).
 * Generates single-use opaque connection capsules (KBCON1.) and Crockford Base32 claim codes.
 *
 * Usage:
 *   node scripts/relay-add-teacher.mjs [teacherId] [name] [email]
 *   node scripts/relay-add-teacher.mjs --rotate <teacherId>
 *   node scripts/relay-add-teacher.mjs --deactivate <teacherId>
 *   node scripts/relay-add-teacher.mjs --activate <teacherId>
 */

import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createDatabase } from '../server/relay/db.js';
import {
  generateToken,
  hashToken,
  encodeConnectCapsule,
  generateClaimCode,
  hashClaimCode
} from '../server/relay/auth.js';

let args;
try {
  ({ values: args, positionals: args._ } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string', default: process.env.KB_RELAY_DB || './data/relay.sqlite' },
      'public-url': { type: 'string', default: process.env.KB_RELAY_PUBLIC_URL || 'http://localhost:3000' },
      'app-url': { type: 'string', default: process.env.KB_APP_PUBLIC_URL || '' },
      email: { type: 'string', default: '' },
      rotate: { type: 'string', default: '' },
      deactivate: { type: 'string', default: '' },
      activate: { type: 'string', default: '' },
      help: { type: 'boolean', default: false }
    }
  }));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (args.help) {
  console.log(`Usage: node scripts/relay-add-teacher.mjs [options] [teacherId] [name] [email]
  --public-url <url>    Relay server base URL (e.g. Cloudflare Worker: https://relay.myschool.edu)
  --app-url <url>       Web app URL (e.g. Cloudflare Pages: https://app.myschool.edu)
  --email <email>       Teacher email for School SSO / OIDC matching
  --rotate <teacherId>  Atomically rotate teacher credentials and print fresh claim code & capsule
  --deactivate <id>     Revoke access for a teacher account
  --activate <id>       Restore access for a teacher account
  --db <path>           Relay SQLite database path`);
  process.exit(0);
}

const db = createDatabase(args.db);
const relayUrl = (args['public-url'] || 'http://localhost:3000').replace(/\/+$/, '');
const appUrl = (args['app-url'] || relayUrl).replace(/\/+$/, '');

try {
  // 1. Deactivate action
  if (args.deactivate) {
    const tid = args.deactivate;
    const ok = db.teachers.setActive(tid, 0);
    if (!ok) throw new Error(`Teacher "${tid}" not found`);
    console.log(`Teacher "${tid}" has been DEACTIVATED. All future API requests will be rejected.`);
    process.exit(0);
  }

  // 2. Activate action
  if (args.activate) {
    const tid = args.activate;
    const ok = db.teachers.setActive(tid, 1);
    if (!ok) throw new Error(`Teacher "${tid}" not found`);
    console.log(`Teacher "${tid}" has been ACTIVATED.`);
    process.exit(0);
  }

  // 3. Rotate action
  if (args.rotate) {
    const tid = args.rotate;
    const existing = db.teachers.getById(tid);
    if (!existing) throw new Error(`Teacher "${tid}" not found`);

    const newToken = generateToken();
    const newHash = hashToken(newToken);
    const claimCode = generateClaimCode();
    const claimHash = hashClaimCode(claimCode);
    const claimExpiresAt = new Date(Date.now() + 7 * 86400000).toISOString();

    db.teachers.adminResetToken(tid, newHash, claimHash, claimExpiresAt);

    const capsule = encodeConnectCapsule({
      relayUrl,
      token: newToken,
      teacherId: tid,
      name: existing.name
    });
    const onboardingUrl = `${appUrl}/#/connect?c=${capsule}`;
    const claimUrl = `${appUrl}/#/connect?code=${claimCode}`;

    console.log('---------------------------------------------------------');
    console.log(` Credentials rotated for Teacher: ${tid} (${existing.name})`);
    console.log('---------------------------------------------------------');
    console.log(` One-Time Claim Code : ${claimCode}  (valid for 7 days)`);
    console.log(` Claim Link          : ${claimUrl}`);
    console.log(` Onboarding Link     : ${onboardingUrl}`);
    console.log('---------------------------------------------------------');
    process.exit(0);
  }

  // 4. Create new teacher
  const pos = args._ || [];
  const teacherId = pos[0] || `teacher-${randomBytes(4).toString('hex')}`;
  const teacherName = pos[1] || 'Teacher';
  const email = (args.email || pos[2] || '').trim().toLowerCase();

  const token = generateToken();
  const tokenHash = hashToken(token);
  const claimCode = generateClaimCode();
  const claimHash = hashClaimCode(claimCode);
  const claimExpiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  const createdAt = new Date().toISOString();

  db.teachers.create({
    id: teacherId,
    name: teacherName,
    email: email || null,
    tokenHash,
    claimHash,
    claimExpiresAt,
    active: 1
  });

  const capsule = encodeConnectCapsule({
    relayUrl,
    token,
    teacherId,
    name: teacherName
  });
  const onboardingUrl = `${appUrl}/#/connect?c=${capsule}`;
  const claimUrl = `${appUrl}/#/connect?code=${claimCode}`;

  console.log('---------------------------------------------------------');
  console.log(' Teacher account created successfully (Schema v4)');
  console.log('---------------------------------------------------------');
  console.log(` Teacher ID : ${teacherId}`);
  console.log(` Name       : ${teacherName}`);
  if (email) console.log(` Email      : ${email} (School SSO / OIDC enabled)`);
  console.log(` Database   : ${args.db}`);
  console.log(` Token      : ${token}`);
  console.log(` Relay URL  : ${relayUrl}`);
  console.log(` App URL    : ${appUrl}`);
  console.log('---------------------------------------------------------');
  console.log(' SECURE ONBOARDING OPTIONS (NO PLAINTEXT CREDENTIALS LEAKED):');
  console.log('');
  console.log(' 1. Short 12-char Claim Code (single use, expires in 7 days):');
  console.log(`    Code: ${claimCode}`);
  console.log(`    Link: ${claimUrl}`);
  console.log('');
  console.log(' 2. Opaque Connection Capsule (rotates atomically on connect):');
  console.log(`    Link: ${onboardingUrl}`);
  console.log('---------------------------------------------------------');
  console.log(' Cloudflare D1 SQL command (if using Cloudflare):');
  const d1Email = email ? `'${email.replace(/'/g, "''")}'` : 'NULL';
  console.log(` npx wrangler d1 execute kb-relay-db --remote --command="INSERT OR IGNORE INTO teachers (id, name, email, token_hash, claim_hash, claim_expires_at, active, created_at) VALUES ('${teacherId}', '${teacherName.replace(/'/g, "''")}', ${d1Email}, '${tokenHash}', '${claimHash}', '${claimExpiresAt}', 1, '${createdAt}');"`);
  console.log('---------------------------------------------------------');
} catch (err) {
  console.error('Failed to manage teacher account:', err.message);
  process.exit(1);
}
