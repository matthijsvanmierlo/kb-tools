#!/usr/bin/env node
/**
 * School IT side of school-assisted recovery and term archives. Runs offline.
 *
 * A teacher lost their recovery code but remembers their escrow passphrase:
 *   npm run escrow:recover -- --key school-escrow-private.json --backup kennisboost_backup.json
 *   → prints an unlock code (KBESC1.…). The teacher enters it with their passphrase under
 *     Restore backup → "Lost your recovery code?". This tool cannot open the backup by itself.
 *
 * Open a term archive (only if it was made with archivesReadableBySchool):
 *   npm run escrow:recover -- --key school-escrow-private.json --archive term.kbarchive.json --out ./records
 *   → writes snapshot.json and one folder of student records per student.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { SubmissionCrypto, bytesToB64 } from '../src/core/submission-crypto.js';
import { ESCROW_UNLOCK_PREFIX } from '../src/core/keyvault.js';
import { openTermArchiveAsSchool } from '../src/core/records-archive.js';
import { buildStudentRecord, studentIdsIn, recordToCsvFiles } from '../src/core/records-export.js';

function readPrivateKey(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data.privateJwk) throw new Error(`${file} is not a KennisBoost escrow private key`);
  return data;
}

/** Backup file → unlock code for the teacher (needs their passphrase to be of any use) */
export async function unlockCodeForBackup(backupText, privateKey) {
  const outer = JSON.parse(backupText);
  if (outer?.kennisboost_backup !== 3) throw new Error('This is not an encrypted KennisBoost backup.');
  if (!outer.escrow?.envelope) throw new Error('This backup has no school-assisted recovery data (the teacher had not set a passphrase when it was made).');
  if (outer.escrow.admin_fingerprint && privateKey.fingerprint && outer.escrow.admin_fingerprint !== privateKey.fingerprint) {
    throw new Error(`This backup was registered with escrow key ${outer.escrow.admin_fingerprint}, not ${privateKey.fingerprint}.`);
  }
  const { salt, inner } = await SubmissionCrypto.decryptFromStudent(privateKey.privateJwk, outer.escrow.envelope);
  const payload = JSON.stringify({ key_id: outer.key_id, salt, inner });
  return ESCROW_UNLOCK_PREFIX + bytesToB64(new TextEncoder().encode(payload));
}

/** Archive → decrypted snapshot plus per-student records written to outDir */
export async function exportArchive(archiveText, privateKey, outDir) {
  const snapshot = await openTermArchiveAsSchool(archiveText, privateKey.privateJwk);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(outDir, 'snapshot.json'), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  const ids = studentIdsIn(snapshot.data);
  for (const id of ids) {
    const record = buildStudentRecord(snapshot.data, id);
    const dir = path.join(outDir, id.replace(/[^A-Za-z0-9_.-]+/g, '_'));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify(record, null, 2), { mode: 0o600 });
    for (const [name, csv] of Object.entries(recordToCsvFiles(record))) fs.writeFileSync(path.join(dir, name), csv, { mode: 0o600 });
  }
  return { students: ids.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { values } = parseArgs({ options: {
    key: { type: 'string' }, backup: { type: 'string' }, archive: { type: 'string' }, out: { type: 'string', default: './archive-records' }
  } });
  try {
    if (!values.key || (!values.backup && !values.archive)) throw new Error('Usage: --key <private key file> (--backup <file> | --archive <file> [--out dir])');
    const key = readPrivateKey(values.key);
    if (values.backup) {
      const code = await unlockCodeForBackup(fs.readFileSync(values.backup, 'utf8'), key);
      console.log('Give this unlock code to the teacher (it is useless without their passphrase):\n');
      console.log(code);
    } else {
      const { students } = await exportArchive(fs.readFileSync(values.archive, 'utf8'), key, values.out);
      console.log(`Archive opened: snapshot.json and records for ${students} students in ${path.resolve(values.out)}. This folder contains student records; keep it secure.`);
    }
  } catch (err) {
    console.error(`escrow-recover failed: ${err.message}`);
    process.exit(1);
  }
}
