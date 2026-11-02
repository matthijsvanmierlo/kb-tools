// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createDatabase } from '../server/relay/db.js';
import { createD1Database } from '../server/relay/d1-db.js';
import {
  generateToken,
  hashToken,
  encodeConnectCapsule,
  decodeConnectCapsule,
  generateClaimCode,
  normalizeClaimCode,
  hashClaimCode,
  CONNECT_CAPSULE_PREFIX
} from '../server/relay/auth.js';
import { parseConnectionInput } from '../src/core/relay-config.js';
import { createRelayFetchHandler } from '../server/relay/handler.js';
import { verifyOidcToken } from '../server/relay/oidc.js';
import { storage } from '../src/core/storage.js';
import { KeyVault } from '../src/core/keyvault.js';
import {
  setTransportConfig,
  getTransportConfig,
  clearTransportConfig,
  getTransport,
  RELAY_VAULT_SECRET
} from '../src/core/transport.js';
import { ConfirmDialog } from '../src/utils/dialogs.js';
import { router } from '../src/router.js';

/**
 * Creates an in-memory mock of Cloudflare D1 (env.DB) using node:sqlite.
 */
function createMockD1() {
  const db = new DatabaseSync(':memory:');
  return {
    raw: db,
    async exec(sql) {
      db.exec(sql);
    },
    prepare(sql) {
      return {
        _params: [],
        bind(...params) {
          this._params = params;
          return this;
        },
        async first() {
          const stmt = db.prepare(sql);
          return stmt.get(...this._params) || null;
        },
        async all() {
          const stmt = db.prepare(sql);
          const results = stmt.all(...this._params);
          return { results, meta: { changes: 0 } };
        },
        async run() {
          const stmt = db.prepare(sql);
          const res = stmt.run(...this._params);
          return { meta: { changes: res.changes } };
        }
      };
    }
  };
}

describe('Phase 50: Relay Connection & Security Parity', () => {
  beforeEach(async () => {
    localStorage.clear();
    sessionStorage.clear();
    await storage.init();
    await setTransportConfig(null);
  });

  afterEach(async () => {
    await clearTransportConfig();
  });

  // ---------------------------------------------------------------------------
  // 1. Schema v4 & Database Repositories
  // ---------------------------------------------------------------------------
  describe('Schema v4 & Dual-Backend Database Parity', () => {
    it('creates SQLite database with Schema v4 columns and indexes', () => {
      const db = createDatabase(':memory:');
      const row = db.raw.prepare('PRAGMA user_version').get();
      expect(Number(row.user_version)).toBe(4);

      // Verify columns on teachers table
      const columns = db.raw.prepare('PRAGMA table_info(teachers)').all();
      const colNames = columns.map(c => c.name);
      expect(colNames).toContain('email');
      expect(colNames).toContain('claim_hash');
      expect(colNames).toContain('claim_expires_at');
      expect(colNames).toContain('active');
      expect(colNames).toContain('token_rotated_at');

      // Create teacher with email and claim code
      const claimCode = generateClaimCode();
      const claimHash = hashClaimCode(claimCode);
      const token = generateToken();
      const tokenHash = hashToken(token);

      db.teachers.create({
        id: 't-test-1',
        name: 'Ms. Lovelace',
        email: 'lovelace@school.edu',
        tokenHash,
        claimHash,
        claimExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        active: 1
      });

      const teacher = db.teachers.getById('t-test-1');
      expect(teacher.name).toBe('Ms. Lovelace');
      expect(teacher.email).toBe('lovelace@school.edu');
      expect(teacher.active).toBe(1);

      // Lookup by email
      const byEmail = db.teachers.getByEmail('lovelace@school.edu');
      expect(byEmail).not.toBeNull();
      expect(byEmail.id).toBe('t-test-1');

      // Test deactivation
      db.teachers.setActive('t-test-1', 0);
      expect(db.teachers.getById('t-test-1').active).toBe(0);

      // Rotating inactive teacher returns false
      const newToken = generateToken();
      const newHash = hashToken(newToken);
      expect(db.teachers.rotateToken('t-test-1', newHash)).toBe(false);

      // Reactivate teacher and rotate successfully
      db.teachers.setActive('t-test-1', 1);
      const rotated = db.teachers.rotateToken('t-test-1', newHash);
      expect(rotated).toBe(true);
      const updatedTeacher = db.teachers.getById('t-test-1');
      expect(updatedTeacher.token_hash).toBe(newHash);
      expect(updatedTeacher.claim_hash).toBeNull(); // Claim hash cleared on rotation
      expect(updatedTeacher.token_rotated_at).not.toBeNull();

      // Test claimByCodeHash
      const claimCode2 = generateClaimCode();
      const claimHash2 = hashClaimCode(claimCode2);
      db.teachers.create({
        id: 't-test-2',
        name: 'Mr. Babbage',
        tokenHash: hashToken(generateToken()),
        claimHash: claimHash2,
        claimExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        active: 1
      });

      const claimedNewHash = hashToken(generateToken());
      const claimed = db.teachers.claimByCodeHash(claimHash2, claimedNewHash);
      expect(claimed).not.toBeNull();
      expect(claimed.id).toBe('t-test-2');
      expect(claimed.token_hash).toBe(claimedNewHash);
      expect(claimed.claim_hash).toBeNull();

      // Re-claiming with same code fails
      const reclaim = db.teachers.claimByCodeHash(claimHash2, hashToken(generateToken()));
      expect(reclaim).toBeNull();

      db.raw.close();
    });

    it('initializes Cloudflare D1 with identical Schema v4 methods', async () => {
      const mockD1 = createMockD1();
      const d1 = createD1Database(mockD1);
      await d1.initSchema();

      const token = generateToken();
      const tokenHash = hashToken(token);
      const claimCode = generateClaimCode();
      const claimHash = hashClaimCode(claimCode);

      await d1.teachers.create({
        id: 'd1-t-1',
        name: 'Grace Hopper',
        email: 'hopper@navy.mil',
        tokenHash,
        claimHash,
        claimExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        active: 1
      });

      const t = await d1.teachers.getById('d1-t-1');
      expect(t.name).toBe('Grace Hopper');
      expect(t.email).toBe('hopper@navy.mil');
      expect(t.active).toBe(1);

      const byEmail = await d1.teachers.getByEmail('hopper@navy.mil');
      expect(byEmail.id).toBe('d1-t-1');

      // Rotate token in D1
      const newToken = generateToken();
      const newHash = hashToken(newToken);
      const rotated = await d1.teachers.rotateToken('d1-t-1', newHash);
      expect(rotated).toBe(true);
      const updatedD1Teacher = await d1.teachers.getById('d1-t-1');
      expect(updatedD1Teacher.token_hash).toBe(newHash);
      expect(updatedD1Teacher.claim_hash).toBeNull();

      // Claim code in D1
      const claimCode3 = generateClaimCode();
      const claimHash3 = hashClaimCode(claimCode3);
      await d1.teachers.create({
        id: 'd1-t-2',
        name: 'Alan Turing',
        tokenHash: hashToken(generateToken()),
        claimHash: claimHash3,
        claimExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        active: 1
      });

      const d1Claimed = await d1.teachers.claimByCodeHash(claimHash3, hashToken(generateToken()));
      expect(d1Claimed.id).toBe('d1-t-2');
      expect(d1Claimed.claim_hash).toBeNull();

      // Double claim fails in D1
      const d1Reclaim = await d1.teachers.claimByCodeHash(claimHash3, hashToken(generateToken()));
      expect(d1Reclaim).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Opaque Capsules & Claim Codes
  // ---------------------------------------------------------------------------
  describe('Opaque Connection Capsules & Crockford Base32 Claim Codes', () => {
    it('encodes and decodes KBCON1. connection capsules', () => {
      const capsule = encodeConnectCapsule({
        relayUrl: 'https://relay.school.edu',
        token: 'secret-token-12345',
        teacherId: 'T-99',
        name: 'Dr. Euler'
      });

      expect(capsule.startsWith(CONNECT_CAPSULE_PREFIX)).toBe(true);

      const decoded = decodeConnectCapsule(capsule);
      expect(decoded).not.toBeNull();
      expect(decoded.baseUrl).toBe('https://relay.school.edu');
      expect(decoded.token).toBe('secret-token-12345');
      expect(decoded.teacherId).toBe('T-99');
      expect(decoded.name).toBe('Dr. Euler');

      // Tampered capsule returns null
      expect(decodeConnectCapsule('KBCON1.invalidbase64!@#$')).toBeNull();
      expect(decodeConnectCapsule('NOTACAPSULE')).toBeNull();
    });

    it('generates and normalizes Crockford Base32 claim codes', () => {
      const code = generateClaimCode();
      expect(code).toMatch(/^KBC-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

      // Normalization handles dashes, spaces, casing, and typos (O->0, I/L->1)
      const input = 'kbc-1o2l-3i4o-abcd';
      const normalized = normalizeClaimCode(input);
      expect(normalized).toBe('10213140ABCD');

      const hash1 = hashClaimCode(input);
      const hash2 = hashClaimCode('1021-3140-ABCD');
      expect(hash1).toBe(hash2);
    });

    it('parses diverse connection inputs via parseConnectionInput', () => {
      // 1. Connection capsule
      const capsule = encodeConnectCapsule({
        relayUrl: 'https://relay.lan',
        token: 'tok-abc',
        teacherId: 'T-1'
      });
      const p1 = parseConnectionInput(`https://app.lan/#/connect?c=${capsule}`);
      expect(p1.kind).toBe('capsule');
      expect(p1.baseUrl).toBe('https://relay.lan');
      expect(p1.token).toBe('tok-abc');

      // 2. Claim code
      const p2 = parseConnectionInput('KBC-7K3M-9P2X-4Y5Z', { defaultBaseUrl: 'https://relay.lan' });
      expect(p2.kind).toBe('claim');
      expect(p2.code).toBe('7K3M9P2X4Y5Z');
      expect(p2.baseUrl).toBe('https://relay.lan');

      // 3. Legacy link
      const p3 = parseConnectionInput('https://app.lan/#/connect?relay=https://relay.lan&token=tok-xyz&id=T-2');
      expect(p3.kind).toBe('legacy');
      expect(p3.baseUrl).toBe('https://relay.lan');
      expect(p3.token).toBe('tok-xyz');
      expect(p3.teacherId).toBe('T-2');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Server Endpoints: /auth/roll, /auth/claim, /health
  // ---------------------------------------------------------------------------
  describe('Server Endpoints: Single-Use Key Rotation & Claim Codes', () => {
    let db;
    let handleRequest;
    const initialToken = generateToken();
    const claimCode = generateClaimCode();

    beforeEach(() => {
      db = createDatabase(':memory:');
      db.teachers.create({
        id: 't-roll',
        name: 'Rolling Teacher',
        tokenHash: hashToken(initialToken),
        claimHash: hashClaimCode(claimCode),
        claimExpiresAt: new Date(Date.now() + 86400000).toISOString(),
        active: 1
      });

      handleRequest = createRelayFetchHandler({ db });
    });

    afterEach(() => {
      db.raw.close();
    });

    it('health endpoint advertises auth methods', async () => {
      const res = await handleRequest(new Request('http://localhost:3000/api/v1/health'));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.schema_version).toBe(4);
      expect(data.auth_methods).toContain('bearer');
      expect(data.auth_methods).toContain('claim');
      expect(data.auth_methods).toContain('roll');
    });

    it('atomically rolls keys via POST /auth/roll and invalidates previous token', async () => {
      // 1. Initial token succeeds on /whoami
      const whoRes1 = await handleRequest(new Request('http://localhost:3000/api/v1/whoami', {
        headers: { Authorization: `Bearer ${initialToken}` }
      }));
      expect(whoRes1.status).toBe(200);

      // 2. Call /auth/roll to rotate key
      const rollRes = await handleRequest(new Request('http://localhost:3000/api/v1/auth/roll', {
        method: 'POST',
        headers: { Authorization: `Bearer ${initialToken}` }
      }));
      expect(rollRes.status).toBe(200);
      const rollData = await rollRes.json();
      expect(rollData.ok).toBe(true);
      expect(rollData.token).toBeDefined();
      expect(rollData.token).not.toBe(initialToken);
      expect(rollData.teacher.id).toBe('t-roll');

      const freshToken = rollData.token;

      // 3. Old token is now permanently invalid
      const whoResOld = await handleRequest(new Request('http://localhost:3000/api/v1/whoami', {
        headers: { Authorization: `Bearer ${initialToken}` }
      }));
      expect(whoResOld.status).toBe(401);

      // 4. Fresh token succeeds
      const whoResFresh = await handleRequest(new Request('http://localhost:3000/api/v1/whoami', {
        headers: { Authorization: `Bearer ${freshToken}` }
      }));
      expect(whoResFresh.status).toBe(200);
      const freshWhoData = await whoResFresh.json();
      expect(freshWhoData.teacher_id).toBe('t-roll');
    });

    it('rejects deactivated teachers on key rotation and authentication', async () => {
      db.teachers.setActive('t-roll', 0);

      const rollRes = await handleRequest(new Request('http://localhost:3000/api/v1/auth/roll', {
        method: 'POST',
        headers: { Authorization: `Bearer ${initialToken}` }
      }));
      expect(rollRes.status).toBe(403);

      const whoRes = await handleRequest(new Request('http://localhost:3000/api/v1/whoami', {
        headers: { Authorization: `Bearer ${initialToken}` }
      }));
      expect(whoRes.status).toBe(403);
    });

    it('claims one-time code via POST /auth/claim and rejects second use', async () => {
      // 1. Claim the code
      const claimRes = await handleRequest(new Request('http://localhost:3000/api/v1/auth/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: claimCode })
      }));
      expect(claimRes.status).toBe(200);
      const claimData = await claimRes.json();
      expect(claimData.ok).toBe(true);
      expect(claimData.token).toBeDefined();
      expect(claimData.teacher.id).toBe('t-roll');

      // 2. Second claim with same code fails
      const claimRes2 = await handleRequest(new Request('http://localhost:3000/api/v1/auth/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: claimCode })
      }));
      expect(claimRes2.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // 4. KeyVault Credential Sealing & Auto-Migration
  // ---------------------------------------------------------------------------
  describe('KeyVault Credential Sealing & Zero Plaintext in Storage', () => {
    it('seals bearer token inside KeyVault and keeps plaintext token out of sync_config', async () => {
      await setTransportConfig({
        baseUrl: 'https://relay.school.edu',
        token: 'super-secret-bearer-token',
        teacherId: 'T-101',
        name: 'Marie Curie'
      });

      // 1. Verify app_metadata.sync_config has NO plaintext token
      const rawMetadata = await storage.getMetadata('sync_config');
      expect(rawMetadata).not.toBeNull();
      expect(rawMetadata.baseUrl).toBe('https://relay.school.edu');
      expect(rawMetadata.teacherId).toBe('T-101');
      expect(rawMetadata.sealed).toBe(true);
      expect(rawMetadata.token).toBeUndefined(); // MUST NOT leak token into unencrypted metadata!

      // 2. Verify KeyVault contains the secret encrypted
      const vaultSecret = await KeyVault.getSecret(storage, RELAY_VAULT_SECRET);
      expect(vaultSecret).not.toBeNull();
      expect(vaultSecret.token).toBe('super-secret-bearer-token');

      // 3. Verify getTransportConfig unseals transparently
      const unsealed = await getTransportConfig();
      expect(unsealed.token).toBe('super-secret-bearer-token');
      expect(unsealed.teacherId).toBe('T-101');

      // 4. Verify getTransport constructs active RelayTransport with token
      const transport = await getTransport();
      expect(transport.baseUrl).toBe('https://relay.school.edu');
      expect(transport.token).toBe('super-secret-bearer-token');
    });

    it('automatically migrates legacy unsealed tokens into KeyVault on first read', async () => {
      // Simulate legacy unencrypted storage
      await storage.setMetadata('sync_config', {
        baseUrl: 'https://relay.school.edu',
        token: 'legacy-unsealed-token',
        teacherId: 'T-Legacy',
        name: 'Legacy Teacher'
      });

      // Call getTransportConfig()
      const migrated = await getTransportConfig();
      expect(migrated.token).toBe('legacy-unsealed-token');

      // Verify plaintext token was erased from app_metadata.sync_config
      const rawMetadata = await storage.getMetadata('sync_config');
      expect(rawMetadata.token).toBeUndefined();
      expect(rawMetadata.sealed).toBe(true);

      // Verify token was sealed into KeyVault
      const vaultSecret = await KeyVault.getSecret(storage, RELAY_VAULT_SECRET);
      expect(vaultSecret.token).toBe('legacy-unsealed-token');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Co-Teacher Drop Box Permissions with dropSecret
  // ---------------------------------------------------------------------------
  describe('Drop Box Permissions & Co-Teacher Access', () => {
    let db;
    let handleRequest;
    const teacherToken = generateToken();

    beforeEach(() => {
      db = createDatabase(':memory:');
      db.teachers.create({
        id: 'teacher-main',
        name: 'Main Teacher',
        tokenHash: hashToken(teacherToken),
        active: 1
      });
      handleRequest = createRelayFetchHandler({ db });
    });

    afterEach(() => {
      db.raw.close();
    });

    it('allows submission and listing via drop secret for co-teachers', async () => {
      // 1. Create a drop with drop secret
      const createDropRes = await handleRequest(new Request('http://localhost:3000/api/v1/drops', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${teacherToken}`
        },
        body: JSON.stringify({
          assignment_id: 'assign-math-1',
          drop_secret: 'co-teacher-secret-777'
        })
      }));
      expect(createDropRes.status).toBe(201);
      const dropData = await createDropRes.json();
      const dropId = dropData.drop_id;
      expect(dropId).toBeDefined();

      // 2. Submit student envelope to drop using drop secret
      const submitRes = await handleRequest(new Request(`http://localhost:3000/api/v1/drops/${dropId}/submissions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'X-KB-Drop-Secret': 'co-teacher-secret-777'
        },
        body: 'KBSUB1.encrypted-student-payload-ciphertext'
      }));
      expect(submitRes.status).toBe(201);

      // 3. Co-teacher (or student check) lists submissions using drop secret without teacher bearer token
      const coTeacherListRes = await handleRequest(new Request(`http://localhost:3000/api/v1/drops/${dropId}/submissions`, {
        headers: {
          'X-KB-Drop-Secret': 'co-teacher-secret-777'
        }
      }));
      expect(coTeacherListRes.status).toBe(200);
      const itemsData = await coTeacherListRes.json();
      expect(itemsData.items.length).toBe(1);

      // 4. Request with WRONG drop secret and NO bearer token fails with 403
      const badSecretListRes = await handleRequest(new Request(`http://localhost:3000/api/v1/drops/${dropId}/submissions`, {
        headers: {
          'X-KB-Drop-Secret': 'wrong-secret'
        }
      }));
      expect(badSecretListRes.status).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Zero Plaintext DOM & Onboarding Route Security
  // ---------------------------------------------------------------------------
  describe('Onboarding Route & Zero Plaintext DOM Integrity', () => {
    it('scrubs URL parameters and automatically rolls token on connection', async () => {
      const db = createDatabase(':memory:');
      const token1 = generateToken();
      db.teachers.create({
        id: 't-onboard',
        name: 'Onboarding Teacher',
        tokenHash: hashToken(token1),
        active: 1
      });
      const fetchHandler = createRelayFetchHandler({ db });

      // Mock global fetch to route to our test handler
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (url, init = {}) => {
        const u = new URL(url);
        return await fetchHandler(new Request(u.href, init));
      });

      // Mock ConfirmDialog to auto-confirm
      vi.spyOn(ConfirmDialog, 'show').mockResolvedValue(true);

      const capsule = encodeConnectCapsule({
        relayUrl: 'http://localhost:3000',
        token: token1,
        teacherId: 't-onboard',
        name: 'Onboarding Teacher'
      });

      // Handle connect route with capsule
      await router._handleConnectRoute({ c: capsule });

      // 1. Confirm dialog was called with server URL and teacher name, NEVER the token
      expect(ConfirmDialog.show).toHaveBeenCalled();
      const dialogCall = ConfirmDialog.show.mock.calls[0][0];
      expect(dialogCall.message).toContain('http://localhost:3000');
      expect(dialogCall.message).toContain('Onboarding Teacher');
      expect(dialogCall.message).not.toContain(token1);

      // 2. Transport config is now sealed in KeyVault
      const conf = await getTransportConfig();
      expect(conf.baseUrl).toBe('http://localhost:3000');
      expect(conf.teacherId).toBe('t-onboard');
      expect(conf.token).toBeDefined();
      expect(conf.token).not.toBe(token1); // Token was automatically rolled!

      // 3. The old link token is dead on the server
      const oldCheck = await fetchHandler(new Request('http://localhost:3000/api/v1/whoami', {
        headers: { Authorization: `Bearer ${token1}` }
      }));
      expect(oldCheck.status).toBe(401);

      globalThis.fetch = originalFetch;
      db.raw.close();
    });
  });

  // ---------------------------------------------------------------------------
  // 7. School SSO / OIDC Verification & POST /auth/oidc
  // ---------------------------------------------------------------------------
  describe('School SSO / OIDC Token Verification & POST /auth/oidc', () => {
    it('verifies RS256 signed ID token and issues bearer token', async () => {
      const keyPair = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256'
        },
        true,
        ['sign', 'verify']
      );

      const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
      publicJwk.kid = 'test-kid-1';
      publicJwk.alg = 'RS256';
      publicJwk.use = 'sig';

      const header = { alg: 'RS256', kid: 'test-kid-1', typ: 'JWT' };
      const nowSec = Math.floor(Date.now() / 1000);
      const payload = {
        iss: 'https://accounts.google.com',
        aud: 'google-client-id-123.apps.googleusercontent.com',
        sub: '10987654321',
        email: 'lovelace@school.edu',
        email_verified: true,
        name: 'Ada Lovelace',
        iat: nowSec - 10,
        exp: nowSec + 3600
      };

      const b64Url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
      const unsignedToken = `${b64Url(header)}.${b64Url(payload)}`;
      const signatureBytes = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keyPair.privateKey,
        new TextEncoder().encode(unsignedToken)
      );
      const idToken = `${unsignedToken}.${Buffer.from(signatureBytes).toString('base64url')}`;

      // Mock fetch for Google's JWKS
      const mockFetch = vi.fn(async (url) => {
        const u = String(url);
        if (u.includes('certs') || u.includes('jwks')) {
          return new Response(JSON.stringify({ keys: [publicJwk] }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response('Not found', { status: 404 });
      });

      const db = createDatabase(':memory:');
      db.teachers.create({
        id: 't-ada',
        name: 'Ada Lovelace',
        email: 'lovelace@school.edu',
        tokenHash: hashToken(generateToken()),
        active: 1
      });

      const oidcConfig = {
        enabled: true,
        googleClientId: 'google-client-id-123.apps.googleusercontent.com'
      };

      const handler = createRelayFetchHandler({ db, oidc: oidcConfig, fetchImpl: mockFetch });

      const oidcRes = await handler(new Request('http://localhost:3000/api/v1/auth/oidc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'google',
          id_token: idToken
        })
      }));

      expect(oidcRes.status).toBe(200);
      const data = await oidcRes.json();
      expect(data.ok).toBe(true);
      expect(data.token).toBeDefined();
      expect(data.teacher_id).toBe('t-ada');
      expect(data.name).toBe('Ada Lovelace');
      expect(data.email).toBe('lovelace@school.edu');

      db.raw.close();
    });
  });
});
