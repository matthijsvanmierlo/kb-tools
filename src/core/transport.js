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
    return {
      hostPayload: true,
      collectSubmissions: true,
      replication: true,
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
        features: data.features || ['payloads', 'drops']
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
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
      throw new Error(err.error || `Failed to submit to drop: ${res.status}`);
    }
    const data = await res.json();
    return {
      receiptId: data.receipt_id || data.receiptId,
      received_at: data.received_at
    };
  }

  async listDrop(dropId, { since } = {}) {
    const url = new URL(`${this.apiBase}/drops/${encodeURIComponent(dropId)}/submissions`);
    if (since) url.searchParams.set('since', since);
    const res = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `Failed to list submissions: ${res.status}`);
    }
    const data = await res.json();
    return { items: data.items || [] };
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
    const headers = { 'Authorization': `Bearer ${this.token}` };
    if (workspaceKey) headers['X-KB-Workspace-Key'] = workspaceKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${this.apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const e = new Error(err.error || `Sync request failed: ${res.status}`);
      e.status = res.status;
      throw e;
    }
    return res.status === 204 ? null : res.json();
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
