/**
 * Google Drive backup location (Google Workspace schools).
 *
 * Scope `drive.file`: the app can only see files it created itself, never the rest of the
 * teacher's Drive. Files go into a "KennisBoost Backups" folder in the teacher's (school-owned)
 * Drive, so the domain keeps them under its retention policies. Contents are ciphertext.
 *
 * Google issues browser apps short-lived tokens (about an hour) and no refresh token without a
 * server, so background backups pause until the teacher clicks "Reconnect". Schools that want
 * fully silent backups can use a Drive for desktop / ChromeOS Drive folder (FsaFolderAdapter).
 */
import { CloudAuthError, TokenStore, openAuthPopup, randomString, redirectUri } from './oauth.js';

export const GDRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const GDRIVE_TOKEN_METADATA = 'cloud_auth_gdrive';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class GoogleDriveAdapter {
  /**
   * @param {{ clientId: string, hostedDomain?: string, folderName?: string }} config
   * @param {{ getMetadata: Function, setMetadata: Function }} store
   */
  constructor(config, store, { fetchImpl = (...a) => fetch(...a), popup = openAuthPopup } = {}) {
    this.config = config;
    this.folderName = config.folderName || 'KennisBoost Backups';
    this.tokens = new TokenStore(store, GDRIVE_TOKEN_METADATA);
    this.fetch = fetchImpl;
    this.popup = popup;
    this.id = 'gdrive';
    this.label = 'Google Drive';
    this.rotates = true;
    this.minDebounceMs = 30000;
    this._folderId = null;
    this._ids = new Map();
  }

  authorizeUrl(state) {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: GDRIVE_SCOPE,
      include_granted_scopes: 'true',
      state
    });
    if (this.config.hostedDomain) params.set('hd', this.config.hostedDomain);
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  async access({ interactive = false } = {}) {
    if (TokenStore.isValid(await this.tokens.get())) return 'granted';
    if (!interactive) return 'prompt';
    await this.signIn();
    return 'granted';
  }

  async signIn() {
    const state = randomString(16);
    const result = await this.popup(this.authorizeUrl(state), state);
    if (!String(result.scope || GDRIVE_SCOPE).includes(GDRIVE_SCOPE)) {
      throw new CloudAuthError('DENIED', 'Google Drive access was not granted.');
    }
    await this.tokens.save(result);
  }

  async signOut() {
    await this.tokens.clear();
  }

  async _request(url, { method = 'GET', headers = {}, body } = {}) {
    const entry = await this.tokens.get();
    if (!TokenStore.isValid(entry)) throw new CloudAuthError('SIGN_IN_REQUIRED', 'Reconnect Google Drive to continue backing up.');
    const res = await this.fetch(url, { method, body, headers: { ...headers, Authorization: `Bearer ${entry.access_token}` } });
    if (res.status === 401) {
      await this.tokens.clear();
      throw new CloudAuthError('SIGN_IN_REQUIRED', 'Reconnect Google Drive to continue backing up.');
    }
    return res;
  }

  async _json(url, opts) {
    const res = await this._request(url, opts);
    if (!res.ok) throw new Error(`Google Drive request failed (${res.status})`);
    return res.json();
  }

  async _folder() {
    if (this._folderId) return this._folderId;
    const q = `name='${this.folderName.replace(/'/g, "\\'")}' and mimeType='${FOLDER_MIME}' and trashed=false`;
    const found = await this._json(`${API}/files?${new URLSearchParams({ q, fields: 'files(id)', spaces: 'drive' })}`);
    if (found.files?.length) {
      this._folderId = found.files[0].id;
    } else {
      const created = await this._json(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.folderName, mimeType: FOLDER_MIME })
      });
      this._folderId = created.id;
    }
    return this._folderId;
  }

  async list() {
    const folder = await this._folder();
    const out = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q: `'${folder}' in parents and trashed=false`,
        fields: 'nextPageToken,files(id,name,modifiedTime)',
        pageSize: '1000',
        spaces: 'drive'
      });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await this._json(`${API}/files?${params}`);
      for (const f of page.files || []) {
        this._ids.set(f.name, f.id);
        out.push({ name: f.name, modified: f.modifiedTime || null });
      }
      pageToken = page.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  async _idFor(name) {
    if (!this._ids.has(name)) await this.list();
    return this._ids.get(name) || null;
  }

  async put(name, text) {
    const id = await this._idFor(name);
    if (id) {
      await this._json(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=id`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: text
      });
      return;
    }
    const folder = await this._folder();
    const boundary = `kb${randomString(12)}`;
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify({ name, parents: [folder], mimeType: 'application/json' }),
      `--${boundary}`,
      'Content-Type: application/json',
      '',
      text,
      `--${boundary}--`
    ].join('\r\n');
    const created = await this._json(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    this._ids.set(name, created.id);
  }

  async get(name) {
    const id = await this._idFor(name);
    if (!id) return null;
    const res = await this._request(`${API}/files/${encodeURIComponent(id)}?alt=media`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Google Drive download failed (${res.status})`);
    return res.text();
  }

  async delete(name) {
    const id = await this._idFor(name);
    if (!id) return;
    const res = await this._request(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`Google Drive delete failed (${res.status})`);
    this._ids.delete(name);
  }

  toConfig() {
    return { type: 'gdrive' };
  }
}
