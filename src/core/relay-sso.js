/**
 * KennisBoost Relay School SSO / OIDC Client
 * Handles teacher authentication via Google Workspace and Microsoft 365 OIDC.
 * Obtains an ID token via the existing secure oauth-callback popup flow,
 * exchanges it with the relay's POST /api/v1/auth/oidc endpoint,
 * and saves the returned bearer token into KeyVault via setTransportConfig.
 */

import { openAuthPopup, redirectUri, randomString } from './storage-adapters/oauth.js';
import { relayApiBase } from './relay-config.js';
import { setTransportConfig } from './transport.js';

export class RelaySsoError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RelaySsoError';
    this.code = code;
  }
}

/**
 * Initiates an OIDC sign-in flow for the relay server.
 *
 * @param {object} options
 * @param {'google'|'microsoft'} options.provider - 'google' or 'microsoft'
 * @param {string} options.baseUrl - The relay server base URL
 * @param {string} options.clientId - OAuth Client ID for the chosen provider
 * @param {string} [options.hostedDomain] - Google Workspace domain constraint (e.g. 'school.edu')
 * @param {string} [options.tenant] - Microsoft 365 tenant ID (defaults to 'common')
 * @returns {Promise<{ ok: boolean, teacher: { id: string, name: string, email: string } }>}
 */
export async function signInWithSchoolSso({
  provider,
  baseUrl,
  clientId,
  hostedDomain = '',
  tenant = 'common'
}) {
  if (!provider || (provider !== 'google' && provider !== 'microsoft')) {
    throw new RelaySsoError('INVALID_PROVIDER', 'Unsupported SSO provider. Choose "google" or "microsoft".');
  }
  if (!baseUrl) {
    throw new RelaySsoError('MISSING_BASE_URL', 'Relay server base URL is required.');
  }
  if (!clientId) {
    throw new RelaySsoError('MISSING_CLIENT_ID', `SSO is not configured. Missing client ID for ${provider}.`);
  }

  const state = randomString(24);
  const nonce = randomString(24);
  const cbUri = redirectUri();

  let authUrl = '';
  if (provider === 'google') {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: cbUri,
      response_type: 'id_token',
      scope: 'openid email profile',
      nonce,
      state
    });
    if (hostedDomain) {
      params.set('hd', hostedDomain);
    }
    authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  } else if (provider === 'microsoft') {
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: cbUri,
      response_type: 'id_token',
      response_mode: 'fragment',
      scope: 'openid email profile',
      nonce,
      state
    });
    const msTenant = tenant || 'common';
    authUrl = `https://login.microsoftonline.com/${encodeURIComponent(msTenant)}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  // Open the provider's sign-in popup
  const result = await openAuthPopup(authUrl, state);
  const idToken = result.id_token;
  if (!idToken) {
    throw new RelaySsoError('NO_TOKEN', 'No identity token received from provider.');
  }

  // Exchange ID token with relay server
  const apiBase = relayApiBase(baseUrl);
  const res = await fetch(`${apiBase}/auth/oidc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      id_token: idToken
    })
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) {
    throw new RelaySsoError(
      body.error || 'AUTH_FAILED',
      body.message || `SSO sign-in failed (${res.status}): ${body.error || 'Access denied'}`
    );
  }

  // Save credentials securely: token is sealed into KeyVault, safe metadata into sync_config
  await setTransportConfig({
    baseUrl,
    token: body.token,
    teacherId: body.teacher?.id,
    name: body.teacher?.name
  });

  return {
    ok: true,
    teacher: body.teacher
  };
}
