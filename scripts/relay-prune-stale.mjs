#!/usr/bin/env node
import { createDatabase } from '../server/relay/db.js';
import { createFsMediaStore, createDbPartsStore } from '../server/relay/media-store.js';
import { DEFAULT_RETENTION_DAYS } from '../server/relay/limits.js';

export async function pruneRelay({ dbPath = null, retentionDays = null, localDir = null } = {}) {
  const resolvedDbPath = dbPath || process.env.KB_RELAY_DB || './data/relay.sqlite';
  const resolvedRetention = retentionDays ?? (process.env.KB_RELAY_RETENTION_DAYS ? Number(process.env.KB_RELAY_RETENTION_DAYS) : DEFAULT_RETENTION_DAYS);
  const resolvedLocalDir = localDir || process.env.KB_CDN_LOCAL_DIR;

  const db = createDatabase(resolvedDbPath);
  let blobStore = null;
  if (resolvedLocalDir) {
    blobStore = createFsMediaStore(resolvedLocalDir);
  } else {
    blobStore = createDbPartsStore(db);
  }

  const results = db.pruneExpired({ retentionDays: resolvedRetention });
  if (results.expiredBlobKeys?.length > 0 && blobStore) {
    await blobStore.deleteMany(results.expiredBlobKeys);
  }

  return results;
}

if (process.argv[1] && process.argv[1].endsWith('relay-prune-stale.mjs')) {
  const args = process.argv.slice(2);
  let dbPath = null;
  let retentionDays = null;
  let localDir = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) {
      dbPath = args[++i];
    } else if (args[i] === '--retention-days' && args[i + 1]) {
      retentionDays = Number(args[++i]);
    } else if (args[i] === '--local-dir' && args[i + 1]) {
      localDir = args[++i];
    }
  }

  pruneRelay({ dbPath, retentionDays, localDir })
    .then((res) => {
      console.log('[Relay Prune] Pruning complete:');
      console.log(`  Payloads pruned:    ${res.payloadsPruned}`);
      console.log(`  Drops pruned:       ${res.dropsPruned}`);
      console.log(`  Submissions pruned: ${res.submissionsPruned}`);
      console.log(`  Drafts pruned:      ${res.draftsPruned}`);
      console.log(`  Workspaces pruned:  ${res.workspacesPruned}`);
      console.log(`  Chunks pruned:      ${res.chunksPruned}`);
      console.log(`  Snapshots pruned:   ${res.snapshotsPruned}`);
      console.log(`  Feeds pruned:       ${res.feedsPruned}`);
      console.log(`  Media refs pruned:  ${res.mediaRefsPruned}`);
      console.log(`  Blobs removed:      ${res.expiredBlobKeys?.length || 0}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Relay Prune] Error during prune:', err);
      process.exit(1);
    });
}
