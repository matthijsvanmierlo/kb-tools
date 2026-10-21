export const RELAY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS teachers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payloads (
  ref TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS drops (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  publish_version INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  secret_hash TEXT,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  drop_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  text TEXT NOT NULL,
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
  FOREIGN KEY (created_by) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_chunks (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  start_seq INTEGER NOT NULL,
  end_seq INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, device_id, start_seq, end_seq),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_snapshots (
  workspace_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (workspace_id, device_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS course_feeds (
  course_id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  etag TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (teacher_id) REFERENCES teachers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_chunks_ws ON sync_chunks(workspace_id, seq);
CREATE INDEX IF NOT EXISTS idx_drafts_updated ON drafts(updated_at);
CREATE INDEX IF NOT EXISTS idx_sync_chunks_created ON sync_chunks(created_at);
CREATE INDEX IF NOT EXISTS idx_payloads_expires ON payloads(expires_at);
CREATE INDEX IF NOT EXISTS idx_drops_expires ON drops(expires_at);
CREATE INDEX IF NOT EXISTS idx_submissions_drop ON submissions(drop_id, received_at);
CREATE INDEX IF NOT EXISTS idx_course_feeds_updated ON course_feeds(updated_at);
`;
