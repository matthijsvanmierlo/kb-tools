export const VERSION = '2.0.0';
export const SCHEMA_VERSION = 3;
export const DEFAULT_PORT = 3000;
export const DEFAULT_RETENTION_DAYS = 180;
export const DEFAULT_TEACHER_QUOTA_MB = 1024; // 1 GB per teacher

export const MAX_PAYLOAD_SIZE = 512 * 1024; // 512 KB
export const MAX_DRAFT_SIZE = 64 * 1024; // 64 KB
export const MAX_SYNC_CHUNK_SIZE = 1 * 1024 * 1024; // 1 MB (client splits)
export const MAX_SYNC_SNAPSHOT_SIZE = 64 * 1024 * 1024; // 64 MB (blob-backed)
export const MAX_SUBMISSION_SIZE = 5 * 1024 * 1024; // 5 MB (blob-backed above 256 KB)
export const INLINE_SUBMISSION_THRESHOLD = 256 * 1024; // 256 KB
export const MAX_STUDENT_MEDIA_SIZE = 25 * 1024 * 1024; // 25 MB
export const MAX_BLOB_PART_SIZE = 800 * 1024; // 800 KB (<= 900 KB for D1 2MB row limit)
export const CHUNK_LIST_PAGE_LIMIT = 50;
export const CHUNK_LIST_PAGE_MAX_BYTES = 8 * 1024 * 1024; // 8 MB total per page
export const SUBMISSION_LIST_PAGE_LIMIT = 100;
export const SUBMISSION_RATE_LIMIT_PER_MIN = 120; // 120 / min per IP for school NAT
