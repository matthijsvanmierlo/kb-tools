/**
 * Managed configuration - KB-CORE-011
 *
 * School IT controls a deployment with a `config.json` next to index.html (and, for older setups,
 * `window.KB_CONFIG` from config.js). It sets defaults and policy, never secrets: anyone who can
 * open the site can read it. Teacher tokens and keys stay in each browser.
 *
 * The file is validated; an invalid file is ignored as a whole (with the reason shown on the Data
 * safety page) rather than half-applied. See docs/it-deployment.md for every option.
 */
import { z } from './zod.js';

const origin = z.string().url().max(500);

const jwkPublicP256 = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().min(40).max(64),
  y: z.string().min(40).max(64)
}).loose();

export const BACKUP_LOCATION_TYPES = ['folder', 'gdrive', 'onedrive'];

export const ManagedConfigSchema = z.object({
  school: z.object({
    name: z.string().max(200).optional(),
    supportUrl: origin.optional(),
    itContact: z.string().max(200).optional()
  }).optional(),
  // School relay. Teachers still connect with their own token.
  relay: z.object({ baseUrl: origin }).optional(),
  cloud: z.object({
    google: z.object({ clientId: z.string().min(10).max(300), hostedDomain: z.string().max(200).optional() }).optional(),
    microsoft: z.object({ clientId: z.string().min(10).max(100), tenant: z.string().max(100).optional() }).optional()
  }).optional(),
  policy: z.object({
    requireAutomaticBackup: z.boolean().optional(),
    backupReminderHours: z.number().int().min(1).max(24 * 30).optional(),
    allowedBackupLocations: z.array(z.enum(BACKUP_LOCATION_TYPES)).min(1).optional(),
    allowDirectTransfer: z.boolean().optional(),
    allowCoTeaching: z.boolean().optional(),
    studentDraftRoaming: z.boolean().optional()
  }).optional(),
  // School-assisted recovery and term archives (see keyvault.js / records-archive.js)
  escrow: z.object({
    adminPublicKey: jwkPublicP256,
    label: z.string().max(200).optional(),
    archivesReadableBySchool: z.boolean().optional()
  }).optional(),
  // Legacy config.js fields (relay connection pre-filled for a single teacher)
  baseUrl: origin.optional(),
  token: z.string().max(200).optional(),
  teacherId: z.string().max(200).optional()
}).loose();

export const DEFAULT_POLICY = Object.freeze({
  requireAutomaticBackup: false,
  backupReminderHours: 72,
  allowedBackupLocations: BACKUP_LOCATION_TYPES,
  allowDirectTransfer: true,
  allowCoTeaching: true,
  studentDraftRoaming: true
});

let current = { config: {}, policy: { ...DEFAULT_POLICY }, source: 'none', error: null };
const CACHE_KEY = 'kb_managed_config';
// window.KB_CONFIG as config.js set it, captured before this module replaces it with the merged result
let scriptConfig;

/**
 * Validate a raw config object. Returns the normalized config, or `{ error }`.
 * @returns {{ config: object, policy: object, error: string|null }}
 */
export function parseManagedConfig(raw) {
  if (raw === null || raw === undefined) return { config: {}, policy: { ...DEFAULT_POLICY }, error: null };
  const result = ManagedConfigSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    return { config: {}, policy: { ...DEFAULT_POLICY }, error: `${issue.path.join('.') || 'config'}: ${issue.message}` };
  }
  const config = result.data;
  return { config, policy: { ...DEFAULT_POLICY, ...(config.policy || {}) }, error: null };
}

/**
 * Load config.json (if the deployment has one) on top of window.KB_CONFIG, validate, and expose
 * the result as window.KB_CONFIG for the modules that read it (transport, cloud adapters).
 */
export async function loadManagedConfig({ fetchImpl = (...a) => fetch(...a), url = 'config.json' } = {}) {
  if (scriptConfig === undefined) scriptConfig = typeof window !== 'undefined' && window.KB_CONFIG ? window.KB_CONFIG : null;
  const fromScript = scriptConfig;
  let fromFile = null;
  let fetchError = null;
  try {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (res.ok) {
      fromFile = await res.json();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(fromFile)); } catch (_) {}
    } else if (res.status === 404) {
      try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      fetchError = 'config.json is not valid JSON';
    } else {
      // Offline: keep applying the school's last known settings
      try { fromFile = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (_) {}
    }
  }
  const merged = fromScript || fromFile ? { ...(fromScript || {}), ...(fromFile || {}) } : null;
  const parsed = parseManagedConfig(merged);
  current = {
    ...parsed,
    error: fetchError || parsed.error,
    source: fromFile ? 'config.json' : fromScript ? 'config.js' : 'none'
  };
  if (current.error) console.warn(`[KennisBoost] Managed configuration ignored: ${current.error}`);
  if (typeof window !== 'undefined') {
    window.KB_CONFIG = current.error ? null : flattenForLegacyReaders(current.config);
  }
  return current;
}

/** transport.js reads KB_CONFIG.baseUrl; the cloud adapters read KB_CONFIG.cloud */
function flattenForLegacyReaders(config) {
  if (!config || !Object.keys(config).length) return null;
  return { ...config, baseUrl: config.baseUrl || config.relay?.baseUrl };
}

export function getManagedConfig() {
  return current;
}

export function getPolicy() {
  return current.policy;
}

/** For tests */
export function setManagedConfigForTests(raw) {
  scriptConfig = undefined;
  current = { ...parseManagedConfig(raw), source: 'test' };
  return current;
}
