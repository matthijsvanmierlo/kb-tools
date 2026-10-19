#!/usr/bin/env node
/**
 * Create the school's escrow key pair for school-assisted recovery and term archives.
 *
 *   npm run escrow:keygen -- --out school-escrow-private.json
 *
 * Keep the private key OFFLINE (an encrypted USB stick in a safe, a password manager vault with
 * two-person access). Put the printed public key in config.json under escrow.adminPublicKey.
 * Losing the private key only disables school-assisted recovery; it never locks anyone out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SubmissionCrypto } from '../src/core/submission-crypto.js';

export async function generateEscrowKeys() {
  const pair = await SubmissionCrypto.generateKeyPair();
  return { publicJwk: pair.publicJwk, privateJwk: pair.privateJwk, fingerprint: pair.fingerprint, created_at: pair.created_at };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { values } = parseArgs({ options: { out: { type: 'string', default: 'school-escrow-private.json' }, force: { type: 'boolean', default: false } } });
  if (fs.existsSync(values.out) && !values.force) {
    console.error(`${values.out} already exists. Use --force to replace it (old backups' escrow would then need the old key).`);
    process.exit(1);
  }
  const keys = await generateEscrowKeys();
  fs.writeFileSync(values.out, JSON.stringify({ kind: 'kennisboost-escrow-private-key', ...keys }, null, 2), { mode: 0o600 });
  console.log(`Private key written to ${path.resolve(values.out)} (fingerprint ${keys.fingerprint}). Store it offline.`);
  console.log('');
  console.log('Add this to config.json:');
  console.log(JSON.stringify({ escrow: { adminPublicKey: keys.publicJwk, label: 'IT department', archivesReadableBySchool: false } }, null, 2));
}
