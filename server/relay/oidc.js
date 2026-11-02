/**
 * OIDC id_token Verifier for Google Workspace and Microsoft Entra ID
 *
 * Implements RS256 JWT signature verification and claim validation using
 * Web Standard crypto.subtle (zero npm dependencies, works in Node.js 20+ and Cloudflare Workers).
 */

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const MS_COMMON_JWKS_URL = 'https://login.microsoftonline.com/common/discovery/v2.0/keys';

// In-memory JWKS cache: { [url]: { keys: Map<kid, CryptoKey>, expiresAt: number } }
const jwksCache = new Map();
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

function base64UrlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  if (typeof atob === 'function') {
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return Buffer.from(padded, 'base64');
}

function parseJwtUnverified(token) {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3) {
    throw new Error('JWT must have 3 dot-separated parts');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const dec = new TextDecoder();
  const header = JSON.parse(dec.decode(base64UrlToBytes(headerB64)));
  const payload = JSON.parse(dec.decode(base64UrlToBytes(payloadB64)));
  const signature = base64UrlToBytes(sigB64);
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  return { header, payload, signature, signedData };
}

async function getJwksKeys(jwksUrl, fetchImpl = fetch) {
  const cached = jwksCache.get(jwksUrl);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.keys;
  }

  const res = await fetchImpl(jwksUrl, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    throw new Error(`Failed to fetch JWKS from ${jwksUrl}: HTTP ${res.status}`);
  }
  const data = await res.json();
  const jwksList = data?.keys || [];
  const keysMap = new Map();

  for (const jwk of jwksList) {
    if (jwk.kty === 'RSA' && (!jwk.alg || jwk.alg === 'RS256')) {
      try {
        const subtle = crypto.subtle;
        const key = await subtle.importKey(
          'jwk',
          { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256' },
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify']
        );
        if (jwk.kid) keysMap.set(jwk.kid, key);
      } catch (_) {}
    }
  }

  jwksCache.set(jwksUrl, { keys: keysMap, expiresAt: Date.now() + JWKS_CACHE_TTL_MS });
  return keysMap;
}

/**
 * Verify an OIDC id_token from Google or Microsoft.
 *
 * @param {{
 *   provider: 'google' | 'microsoft',
 *   idToken: string,
 *   oidcConfig?: {
 *     googleClientId?: string,
 *     googleDomain?: string,
 *     microsoftClientId?: string,
 *     microsoftTenant?: string,
 *     jwksUrlOverride?: string
 *   },
 *   fetchImpl?: typeof fetch
 * }} opts
 * @returns {Promise<{ sub: string, email: string, email_verified: boolean, name: string, hd?: string, tid?: string }>}
 */
export async function verifyOidcToken({ provider, idToken, oidcConfig = {}, fetchImpl = fetch }) {
  if (!idToken) throw new Error('Missing id_token');
  const { header, payload, signature, signedData } = parseJwtUnverified(idToken);

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported JWT algorithm: ${header.alg}`);
  }

  const jwksUrl = oidcConfig.jwksUrlOverride ||
    (provider === 'google' ? GOOGLE_JWKS_URL : MS_COMMON_JWKS_URL);

  const keys = await getJwksKeys(jwksUrl, fetchImpl);
  const cryptoKey = header.kid ? keys.get(header.kid) : null;
  if (!cryptoKey) {
    throw new Error(`Key ID (${header.kid}) not found in JWKS`);
  }

  const subtle = crypto.subtle;
  const verified = await subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signature,
    signedData
  );

  if (!verified) {
    throw new Error('Invalid JWT signature');
  }

  // 1. Expiry & clock skew validation (60s tolerance)
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now - 60) {
    throw new Error('OIDC id_token has expired');
  }
  if (payload.nbf && payload.nbf > now + 60) {
    throw new Error('OIDC id_token is not yet valid');
  }

  // 2. Provider-specific claims validation
  if (provider === 'google') {
    // Check issuer
    const validIssuers = ['https://accounts.google.com', 'accounts.google.com'];
    if (!validIssuers.includes(payload.iss)) {
      throw new Error(`Invalid Google issuer: ${payload.iss}`);
    }
    // Check audience
    if (oidcConfig.googleClientId && payload.aud !== oidcConfig.googleClientId) {
      throw new Error(`Audience mismatch: expected ${oidcConfig.googleClientId}, got ${payload.aud}`);
    }
    // Check hosted domain (hd)
    if (oidcConfig.googleDomain && payload.hd !== oidcConfig.googleDomain) {
      throw new Error(`Hosted domain mismatch: expected ${oidcConfig.googleDomain}, got ${payload.hd}`);
    }
  } else if (provider === 'microsoft') {
    // Check audience
    if (oidcConfig.microsoftClientId && payload.aud !== oidcConfig.microsoftClientId) {
      throw new Error(`Audience mismatch: expected ${oidcConfig.microsoftClientId}, got ${payload.aud}`);
    }
    // Check tenant ID (tid)
    if (oidcConfig.microsoftTenant && oidcConfig.microsoftTenant !== 'organizations' && oidcConfig.microsoftTenant !== 'common') {
      if (payload.tid !== oidcConfig.microsoftTenant) {
        throw new Error(`Tenant mismatch: expected ${oidcConfig.microsoftTenant}, got ${payload.tid}`);
      }
    }
  } else {
    throw new Error(`Unsupported OIDC provider: ${provider}`);
  }

  const email = String(payload.email || payload.preferred_username || '').trim().toLowerCase();
  if (!email) {
    throw new Error('OIDC token does not contain an email address');
  }

  return {
    sub: payload.sub,
    email,
    email_verified: Boolean(payload.email_verified ?? true),
    name: payload.name || email.split('@')[0],
    hd: payload.hd || undefined,
    tid: payload.tid || undefined
  };
}

/** Clear JWKS cache (useful for tests) */
export function clearJwksCache() {
  jwksCache.clear();
}
