import storage from './storage.js';

/**
 * Base abstract class for KennisBoost sync transports.
 */
export class SyncTransport {
  static kind = 'null';

  /**
   * Initialize transport configuration.
   * @param {{ baseUrl?: string, token?: string, teacherId?: string }} config
   */
  async init(config = {}) {
    this.config = config;
    return this;
  }

  get capabilities() {
    return {
      hostPayload: false,
      collectSubmissions: false,
      replication: false,
      roster: false
    };
  }

  /**
   * Check connection and server capabilities.
   * @returns {Promise<{ ok: boolean, serverVersion?: string|null, features?: string[], error?: string }>}
   */
  async health() {
    return { ok: false, serverVersion: null };
  }

  /**
   * Publish an encrypted payload to the relay.
   * @param {{ kind: string, ciphertext: string, expiresAt?: string, meta?: any }} param0
   * @returns {Promise<{ ref: string }>}
   */
  async publishPayload({ kind, ciphertext, expiresAt, meta }) {
    throw new Error('publishPayload not supported by this transport');
  }

  /**
   * Fetch an encrypted payload from the relay.
   * @param {string} ref
   * @returns {Promise<{ kind: string, ciphertext: string }>}
   */
  async fetchPayload(ref) {
    throw new Error('fetchPayload not supported by this transport');
  }

  /**
   * Create an assignment drop box for receiving submissions.
   * @param {{ assignmentId: string, publishVersion?: number, expiresAt?: string }} param0
   * @returns {Promise<{ dropId: string }>}
   */
  async createDrop({ assignmentId, publishVersion, expiresAt }) {
    throw new Error('createDrop not supported by this transport');
  }

  /**
   * Submit an encrypted submission envelope to a drop box (student side, no auth).
   * @param {string} dropId
   * @param {string} envelopeText
   * @param {{ dropSecret?: string|null }} [opts] - from the assignment payload (newer drops require it)
   * @returns {Promise<{ receiptId: string, received_at: string }>}
   */
  async submitToDrop(dropId, envelopeText, opts = {}) {
    throw new Error('submitToDrop not supported by this transport');
  }

  /**
   * List submissions in a drop box (teacher side, authenticated).
   * @param {string} dropId
   * @param {{ since?: string }} options
   * @returns {Promise<{ items: Array<{ id: string, received_at: string, text: string }> }>}
   */
  async listDrop(dropId, { since } = {}) {
    throw new Error('listDrop not supported by this transport');
  }

  /**
   * Delete a drop box.
   * @param {string} dropId
   * @returns {Promise<void>}
   */
  async deleteDrop(dropId) {
    throw new Error('deleteDrop not supported by this transport');
  }

  // State sync (Option B) is implemented in src/core/replication/ on top of the relay's
  // /sync endpoints (RelayTransport.sync*) or the teacher's backup location.
}

/**
 * Null transport representing offline/serverless mode.
 */
export class NullTransport extends SyncTransport {
  static kind = 'null';
}

/**
 * RelayTransport communicating with the reference HTTP relay server (/api/v1).
 */
export class RelayTransport extends SyncTransport {
  static kind = 'relay';

  constructor(config = {}) {
    super();
    this.baseUrl = config.baseUrl || '';
    this.token = config.token || '';
    this.teacherId = config.teacherId || '';
  }

  async init(config = {}) {
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.token = config.token || '';
    this.teacherId = config.teacherId || '';
    return this;
  }

  get apiBase() {
    const base = (this.baseUrl || '').replace(/\/+$/, '');
    if (base.endsWith('/api/v1')) return base;
    return `${base}/api/v1`;
  }

  get capabilities() {
    const isTeacherConfigured = Boolean(this.baseUrl && this.token);
    return {
      hostPayload: isTeacherConfigured,
      collectSubmissions: isTeacherConfigured,
      replication: isTeacherConfigured,
      roster: false
    };
  }

  async health() {
    try {
      const res = await fetch(`${this.apiBase}/health`);
      if (!res.ok) {
        return { ok: false, error: `Server returned HTTP ${res.status}` };
      }
      const data = await res.json();
      return {
        ok: Boolean(data.ok !== false),
        serverVersion: data.version || null,
        version: data.version || null,
        backend: data.backend || null,
        features: data.features || ['payloads', 'drops']
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async getHealth() {
    return this.health();
  }

  async publishPayload({ kind, ciphertext, expiresAt, meta }) {
    const res = await fetch(`${this.apiBase}/payloads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({
        kind,
        ciphertext,
        expires_at: expiresAt,
        meta
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to publish payload: ${res.status}`);
    }
    const data = await res.json();
    return { ref: data.ref };
  }

  async fetchPayload(ref) {
    const res = await fetch(`${this.apiBase}/payloads/${encodeURIComponent(ref)}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to fetch payload: ${res.status}`);
    }
    const data = await res.json();
    return {
      kind: data.kind,
      ciphertext: data.ciphertext
    };
  }

  async createDrop({ assignmentId, publishVersion, expiresAt }) {
    const res = await fetch(`${this.apiBase}/drops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({
        assignment_id: assignmentId,
        publish_version: publishVersion,
        expires_at: expiresAt
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to create drop: ${res.status}`);
    }
    const data = await res.json();
    return { dropId: data.drop_id || data.dropId, dropSecret: data.drop_secret || null };
  }

  async submitToDrop(dropId, envelopeText, { dropSecret = null } = {}) {
    const res = await fetch(`${this.apiBase}/drops/${encodeURIComponent(dropId)}/submissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        ...(dropSecret ? { 'X-KB-Drop-Secret': dropSecret } : {})
      },
      body: envelopeText
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const error = new Error(err.error || `Failed to submit to drop: ${res.status}`);
      error.status = res.status;
      throw error;
    }
    const data = await res.json();
    return {
      receiptId: data.receipt_id || data.receiptId,
      received_at: data.received_at
    };
  }

  async listDrop(dropId, { since = null, after = null, limit = null } = {}) {
    const url = new URL(`${this.apiBase}/drops/${encodeURIComponent(dropId)}/submissions`);
    if (after) url.searchParams.set('after', after);
    else if (since) url.searchParams.set('since', since);
    if (limit) url.searchParams.set('limit', String(limit));
    const res = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const error = new Error(err.error || `Failed to list submissions: ${res.status}`);
      error.status = res.status;
      throw error;
    }
    const data = await res.json();
    return {
      items: data.items || [],
      next_after: data.next_after || null,
      more: !!data.more
    };
  }

  async deleteDrop(dropId) {
    const res = await fetch(`${this.apiBase}/drops/${encodeURIComponent(dropId)}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });
    if (!res.ok && res.status !== 404) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to delete drop: ${res.status}`);
    }
  }

  /**
   * Request a presigned media upload URL from the relay server (teacher only).
   * @param {{ sha256: string, mime: string, ext?: string, size?: number }} opts
   * @returns {Promise<{ upload_url: string, public_url: string, method?: string, headers?: Record<string, string> }>}
   */
  async presignMediaUpload({ sha256, mime, ext, size } = {}) {
    if (!this.baseUrl || !this.token) {
      throw new Error('Teacher relay connection required to presign media uploads');
    }
    const res = await fetch(`${this.apiBase}/media/presign`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`
      },
      body: JSON.stringify({ sha256, mime, ext, size })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to presign media upload: HTTP ${res.status}`);
    }
    return await res.json();
  }

  // --- Student draft roaming (no auth; drafts are encrypted with the student's access code) ---

  async putDraft(dropId, draftId, ciphertext, { dropSecret = null } = {}) {
    const res = await fetch(`${this.apiBase}/drops/${encodeURIComponent(dropId)}/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', ...(dropSecret ? { 'X-KB-Drop-Secret': dropSecret } : {}) },
      body: ciphertext
    });
    if (!res.ok) throw new Error(`Failed to save draft: ${res.status}`);
    return res.json();
  }

  /** @returns {Promise<{ ciphertext: string, updated_at: string }|null>} */
  async getDraft(dropId, draftId, { dropSecret = null } = {}) {
    const res = await fetch(`${this.apiBase}/drops/${encodeURIComponent(dropId)}/drafts/${encodeURIComponent(draftId)}`, {
      headers: dropSecret ? { 'X-KB-Drop-Secret': dropSecret } : {}
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to load draft: ${res.status}`);
    return res.json();
  }

  // --- Replication workspaces (src/core/replication) ---

  async _syncRequest(path, { method = 'GET', workspaceKey = null, body } = {}) {
    const isSnapshot = path.includes('/snapshots');
    const timeoutMs = isSnapshot ? 120000 : 20000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Sync request timed out after ${timeoutMs}ms`)), timeoutMs);

    try {
      const headers = { 'Authorization': `Bearer ${this.token}` };
      if (workspaceKey) headers['X-KB-Workspace-Key'] = workspaceKey;
      if (this.deviceId) headers['X-KB-Device-Id'] = this.deviceId;
      if (this.deviceToken) headers['X-KB-Device-Token'] = this.deviceToken;
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      const res = await fetch(`${this.apiBase}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        const e = new Error(err.error || `Sync request failed: ${res.status}`);
        e.status = res.status;
        throw e;
      }
      return res.status === 204 ? null : res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async getWhoami() {
    return this._syncRequest('/whoami');
  }

  async getUsage() {
    return this._syncRequest('/usage');
  }

  syncAckVector(workspaceId, workspaceKey, vector) {
    return this._syncRequest(`/sync/${encodeURIComponent(workspaceId)}/ack`, {
      method: 'POST',
      workspaceKey,
      body: { deviceId: this.deviceId, vector }
    });
  }

  syncDeleteWorkspace(workspaceId, workspaceKey) {
    return this._syncRequest(`/sync/${encodeURIComponent(workspaceId)}`, {
      method: 'DELETE',
      workspaceKey
    });
  }

  syncDeleteDevice(workspaceId, workspaceKey, deviceId) {
    return this._syncRequest(`/sync/${encodeURIComponent(workspaceId)}/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      workspaceKey
    });
  }

  /** @returns {Promise<{ workspaceId: string, workspaceKey: string }>} */
  async syncCreateWorkspace() {
    const data = await this._syncRequest('/sync', { method: 'POST', body: {} });
    return { workspaceId: data.workspace_id, workspaceKey: data.workspace_key };
  }

  syncPutChunk(workspaceId, workspaceKey, chunk) {
    return this._syncRequest(`/sync/${encodeURIComponent(workspaceId)}/chunks`, { method: 'POST', workspaceKey, body: chunk });
  }

  syncListChunks(workspaceId, workspaceKey, { after = null } = {}) {
    const q = after ? `?after=${encodeURIComponent(after)}` : '';
    return this._syncRequest(`/sync/${encodeURIComponent(workspaceId)}/chunks${q}`, { workspaceKey });
  }

  syncDeleteChunks(workspaceId, workspaceKey, { device_id, through }) {
    const q = new URLSearchParams({ device_id, through: String(through) });
    return this._syncRequest(`/sync/${encodeURIComponent(workspaceId)}/chunks?${q}`, { method: 'DELETE', workspaceKey });
  }

  syncPutSnapshot(workspaceId, workspaceKey, deviceId, snapshot) {
    return this._syncRequest(`/sync/${encodeURIComponent(workspaceId)}/snapshots/${encodeURIComponent(deviceId)}`, { method: 'PUT', workspaceKey, body: snapshot });
  }

  async syncListSnapshots(workspaceId, workspaceKey) {
    return (await this._syncRequest(`/sync/${encodeURIComponent(workspaceId)}/snapshots`, { workspaceKey })).items || [];
  }

  syncGetSnapshot(workspaceId, workspaceKey, deviceId) {
    return this._syncRequest(`/sync/${encodeURIComponent(workspaceId)}/snapshots/${encodeURIComponent(deviceId)}`, { workspaceKey });
  }
}

let _currentTransport = null;

/**
 * Get the current sync transport instance according to configuration precedence:
 * app_metadata.sync_config (the teacher's own token) -> window.KB_CONFIG with a token -> NullTransport
 *
 * @param {{ forceReload?: boolean }} options
 * @returns {Promise<SyncTransport>}
 */
export async function getTransport({ forceReload = false } = {}) {
  if (_currentTransport && !forceReload) {
    return _currentTransport;
  }

  // The teacher's own connection (with their token) wins; managed config only pre-fills the URL
  let config = null;
  try {
    config = await storage.getMetadata('sync_config');
  } catch {
    config = null;
  }
  if (!config?.baseUrl && typeof window !== 'undefined' && window.KB_CONFIG?.baseUrl && window.KB_CONFIG.token) {
    config = window.KB_CONFIG;
  }

  if (config && config.baseUrl) {
    const relay = new RelayTransport();
    await relay.init(config);
    _currentTransport = relay;
  } else {
    _currentTransport = new NullTransport();
  }

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('kb-transport-changed', {
      detail: { transport: _currentTransport }
    }));
  }

  return _currentTransport;
}

/**
 * Update transport configuration and reload active transport.
 * @param {{ baseUrl?: string, token?: string, teacherId?: string }|null} config
 * @returns {Promise<SyncTransport>}
 */
export async function setTransportConfig(config) {
  if (config && config.baseUrl) {
    await storage.setMetadata('sync_config', config);
  } else {
    await storage.setMetadata('sync_config', null);
  }
  return await getTransport({ forceReload: true });
}

export async function clearTransportConfig() {
  await storage.setMetadata('sync_config', null);
  return await getTransport({ forceReload: true });
}

export async function getTransportConfig() {
  return (await storage.getMetadata('sync_config')) || null;
}

/**
 * Check if the active transport has a configured teacher relay with valid credentials.
 * @param {SyncTransport} [transport]
 * @returns {boolean}
 */
export function isTeacherRelayConfigured(transport = _currentTransport) {
  return Boolean(transport instanceof RelayTransport && transport.baseUrl && transport.token);
}

/**
 * Get student-facing relay URL from a course, payload, or global managed config.
 * @param {object} [target]
 * @returns {string|null}
 */
export function getStudentRelayUrl(target = null) {
  const url = target?.relay_url
    || target?.relay?.base_url
    || target?.relay?.baseUrl
    || (_currentTransport instanceof RelayTransport && _currentTransport.baseUrl ? _currentTransport.baseUrl : null)
    || (typeof window !== 'undefined' && (window.KB_CONFIG?.relay?.baseUrl || window.KB_CONFIG?.baseUrl || window.KB_CONFIG?.relayUrl || window.KB_CONFIG?.defaultRelayUrl))
    || null;
  return url ? String(url).replace(/\/+$/, '') : null;
}

/**
 * Check if CDN media upload is configured via the relay or managed config.
 * @param {SyncTransport} [transport]
 * @returns {Promise<boolean>}
 */
export async function isCdnUploadConfigured(transport = null) {
  const t = transport || await getTransport();
  if (t instanceof RelayTransport && t.baseUrl && t.token) {
    try {
      const h = await t.health();
      if (h.ok && Array.isArray(h.features) && h.features.includes('media')) {
        return true;
      }
    } catch (_) {}
  }
  if (typeof window !== 'undefined' && window.KB_CONFIG?.cdn?.baseUrl) {
    return true;
  }
  return false;
}

/**
 * Public Feed Transport for publishing and fetching course feeds
 */
export class PublicFeedTransport {
  constructor(config = {}) {
    this.baseUrl = (config.baseUrl || '').replace(/\/+$/, '');
    this.token = config.token || '';
  }

  get apiBase() {
    const base = (this.baseUrl || '').replace(/\/+$/, '');
    if (base.endsWith('/api/v1')) return base;
    return `${base}/api/v1`;
  }

  async publishCourseFeed(courseId, encryptedFeedBlob, eTag) {
    const res = await fetch(`${this.apiBase}/feed/${encodeURIComponent(courseId)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({
        ciphertext: typeof encryptedFeedBlob === 'string' ? encryptedFeedBlob : JSON.stringify(encryptedFeedBlob),
        etag: eTag
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to publish course feed: ${res.status}`);
    }
    const data = await res.json();
    return { ok: true, etag: data.etag || eTag };
  }

  async fetchCourseFeed(courseId, ifNoneMatch) {
    const headers = {};
    if (ifNoneMatch) {
      headers['If-None-Match'] = ifNoneMatch;
    }
    const res = await fetch(`${this.apiBase}/feed/${encodeURIComponent(courseId)}`, {
      headers
    });
    if (res.status === 304) {
      return { notModified: true, etag: ifNoneMatch };
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const error = new Error(err.error || `Failed to fetch course feed: ${res.status}`);
      error.status = res.status;
      throw error;
    }
    const data = await res.json();
    const etag = res.headers.get('ETag')?.replace(/^"|"$/g, '') || data.etag;
    return {
      notModified: false,
      courseId: data.course_id,
      ciphertext: data.ciphertext,
      etag,
      updatedAt: data.updated_at
    };
  }
}

/**
 * Maps relay HTTP status or network failures to clear, user-friendly language.
 * @param {Error|any} err
 * @returns {string}
 */
export function describeRelayError(err) {
  const status = err?.status || (err?.message && (/status[:\s]+(\d+)/i.exec(err.message)?.[1] ? Number(/status[:\s]+(\d+)/i.exec(err.message)[1]) : null));
  if (status === 413) return 'File too large';
  if (status === 410) return 'Drop box closed';
  if (status === 403 || status === 401) return 'Wrong link or secret';
  if (status === 429) return 'Busy – retry in a minute';
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'Offline';
  if (err?.name === 'TypeError' || /offline|network|failed to fetch/i.test(err?.message || '')) {
    return 'Offline';
  }
  return err?.message || 'Submission failed';
}

