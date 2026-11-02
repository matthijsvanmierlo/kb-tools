import { SCHEMA_VERSION } from './limits.js';

export const RELAY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS teachers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  bytes_used INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blob_parts (
  key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (key, idx)
);

CREATE TABLE IF NOT EXISTS payloads (
  ref TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drops (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  publish_version INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  secret_hash TEXT,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  drop_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  text TEXT,
  body_key TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (drop_id) REFERENCES drops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drafts (
  drop_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (drop_id, draft_id),
  FOREIGN KEY (drop_id) REFERENCES drops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  FOREIGN KEY (created_by) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_devices (
  workspace_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_token_hash TEXT,
  last_seen_at TEXT NOT NULL,
  last_ack_vector TEXT,
  PRIMARY KEY (workspace_id, device_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_chunks (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  body_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, device_id, start_seq, end_seq),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_snapshots (
  workspace_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (workspace_id, device_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS course_feeds (
  course_id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  etag TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS media_refs (
  sha TEXT NOT NULL,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (sha, owner_kind, owner_id)
);

CREATE TABLE IF NOT EXISTS drop_media (
  drop_id TEXT NOT NULL,
  key TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (drop_id) REFERENCES drops(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS feedback_drops (
  drop_id TEXT PRIMARY KEY,
  teacher_id TEXT,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS rate_buckets (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_chunks_ws ON sync_chunks(workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_sync_chunks_created ON sync_chunks(created_at);
CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at);
CREATE INDEX IF NOT EXISTS idx_payloads_expires ON payloads(expires_at);
CREATE INDEX IF NOT EXISTS idx_drops_expires ON drops(expires_at);
CREATE INDEX IF NOT EXISTS idx_submissions_drop ON submissions(drop_id, received_at);
CREATE INDEX IF NOT EXISTS idx_submissions_drop_keyset ON submissions(drop_id, received_at, id);
CREATE INDEX IF NOT EXISTS idx_course_feeds_updated ON course_feeds(updated_at);
CREATE INDEX IF NOT EXISTS idx_course_feeds_expires ON course_feeds(expires_at);
CREATE INDEX IF NOT EXISTS idx_drop_media_drop ON drop_media(drop_id);
CREATE INDEX IF NOT EXISTS idx_feedback_drops_expires ON feedback_drops(expires_at);
CREATE INDEX IF NOT EXISTS idx_media_refs_owner ON media_refs(owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS idx_media_refs_created ON media_refs(created_at);
`;
