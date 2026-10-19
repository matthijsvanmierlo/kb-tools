/**
 * OneDrive / SharePoint backup location (Microsoft 365 schools), via Microsoft Graph.
 *
 * Scope `Files.ReadWrite.AppFolder`: the app gets its own "Apps/KennisBoost" folder in the
 * teacher's OneDrive and cannot see anything else. Sign-in is the authorization-code flow with
 * PKCE for a single-page app (no client secret, no MSAL dependency). Microsoft issues SPA refresh
 * tokens, so background backups keep working for about a day between sign-ins.
 */
import { CloudAuthError, TokenStore, createPkce, openAuthPopup, randomString, redirectUri } from './oauth.js';

export const ONEDRIVE_SCOPES = 'Files.ReadWrite.AppFolder offline_access';
export const ONEDRIVE_TOKEN_METADATA = 'cloud_auth_onedrive';
const APPROOT = 'https://graph.microsoft.com/v1.0/me/drive/special/approot';

export class OneDriveAdapter {
  /**
   * @param {{ clientId: string, tenant?: string }} config - tenant defaults to "organizations"
   *   (work/school accounts only); a school can pin its own tenant ID
   */
  constructor(config, store, { fetchImpl = (...a) => fetch(...a), popup = openAuthPopup } = {}) {
    this.config = config;
    this.authority = `https://login.microsoftonline.com/${encodeURIComponent(config.tenant || 'organizations')}/oauth2/v2.0`;
    this.tokens = new TokenStore(store, ONEDRIVE_TOKEN_METADATA);
    this.fetch = fetchImpl;
    this.popup = popup;
    this.id = 'onedrive';
    this.label = 'OneDrive';
    this.rotates = true;
    this.minDebounceMs = 30000;
  }

  authorizeUrl(state, challenge) {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: redirectUri(),
      response_mode: 'query',
      scope: ONEDRIVE_SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256'
    });
    return `${this.authority}/authorize?${params}`;
  }

  async access({ interactive = false } = {}) {
    if (await this._accessToken()) return 'granted';
    if (!interactive) return 'prompt';
    await this.signIn();
    return 'granted';
  }

  async signIn() {
    const state = randomString(16);
    const { verifier, challenge } = await createPkce();
    const result = await this.popup(this.authorizeUrl(state, challenge), state);
    if (!result.code) throw new CloudAuthError('DENIED', 'OneDrive access was not granted.');
    await this._tokenRequest({
      grant_type: 'authorization_code',
      code: result.code,
      redirect_uri: redirectUri(),
      code_verifier: verifier
    });
  }

  async signOut() {
    await this.tokens.clear();
  }

  async _tokenRequest(fields, previous = null) {
    const res = await this.fetch(`${this.authority}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.config.clientId, scope: ONEDRIVE_SCOPES, ...fields }).toString()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new CloudAuthError('SIGN_IN_REQUIRED', data.error_description || 'Reconnect OneDrive to continue backing up.');
    }
    return this.tokens.save(data, previous);
  }

  /** A valid access token, refreshing silently when possible; null if the teacher must sign in */
  async _accessToken() {
    const entry = await this.tokens.get();
    if (TokenStore.isValid(entry)) return entry.access_token;
    if (!entry?.refresh_token) return null;
    try {
      return (await this._tokenRequest({ grant_type: 'refresh_token', refresh_token: entry.refresh_token }, entry)).access_token;
    } catch (err) {
      await this.tokens.clear();
      return null;
    }
  }

  async _request(url, { method = 'GET', headers = {}, body } = {}) {
    const token = await this._accessToken();
    if (!token) throw new CloudAuthError('SIGN_IN_REQUIRED', 'Reconnect OneDrive to continue backing up.');
    const res = await this.fetch(url, { method, body, headers: { ...headers, Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      await this.tokens.clear();
      throw new CloudAuthError('SIGN_IN_REQUIRED', 'Reconnect OneDrive to continue backing up.');
    }
    return res;
  }

  _itemUrl(name, suffix = '') {
    return `${APPROOT}:/${encodeURIComponent(name)}:${suffix}`;
  }

  async list() {
    const out = [];
    let url = `${APPROOT}/children?$select=name,lastModifiedDateTime,file&$top=999`;
    while (url) {
      const res = await this._request(url);
      if (!res.ok) throw new Error(`OneDrive request failed (${res.status})`);
      const page = await res.json();
      for (const item of page.value || []) {
        if (item.file) out.push({ name: item.name, modified: item.lastModifiedDateTime || null });
      }
      url = page['@odata.nextLink'] || '';
    }
    return out;
  }

  async put(name, text) {
    const res = await this._request(this._itemUrl(name, '/content'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: text
    });
    if (!res.ok) throw new Error(`OneDrive upload failed (${res.status})`);
  }

  async get(name) {
    const res = await this._request(this._itemUrl(name, '/content'));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`OneDrive download failed (${res.status})`);
    return res.text();
  }

  async delete(name) {
    const res = await this._request(this._itemUrl(name), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`OneDrive delete failed (${res.status})`);
  }

  toConfig() {
    return { type: 'onedrive' };
  }
}
