/**
 * utils/supabaseServerConfig.js
 *
 * Security V2.0B-0 — fail-closed credentials for the bot's direct Supabase
 * REST (PostgREST) calls.
 *
 * The bot runs as server-side code (Vercel serverless functions), so it may
 * hold SUPABASE_SERVICE_ROLE_KEY. Contract:
 *  - uses SUPABASE_SERVICE_ROLE_KEY only; NEVER falls back to SUPABASE_ANON_KEY
 *  - missing URL/key => throws SupabaseServerConfigError (callers decide how to
 *    degrade; there is no silent anon fallback)
 *  - a JWT-shaped key whose `role` claim is not `service_role` is rejected
 *  - error messages never contain the key; the key is only ever placed in the
 *    outgoing request headers built here (never logged, never sent to users)
 *
 * Long-term direction: move these few table accesses behind the Express
 * backend (internal HMAC-signed endpoints, see signedBackendClient.js) so the
 * bot holds no database credential at all.
 */

export class SupabaseServerConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SupabaseServerConfigError';
    this.code = code;
  }
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function readJwtRole(key) {
  if (typeof key !== 'string' || !key.startsWith('eyJ')) return null;
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload.role === 'string' ? payload.role : null;
  } catch {
    return null;
  }
}

export function resolveSupabaseServiceConfig(env = process.env) {
  const url = clean(env.SUPABASE_URL);
  const serviceRoleKey = clean(env.SUPABASE_SERVICE_ROLE_KEY);

  if (!url) {
    throw new SupabaseServerConfigError('SUPABASE_URL_MISSING', 'SUPABASE_URL is required for bot database access');
  }
  if (!serviceRoleKey) {
    throw new SupabaseServerConfigError(
      'SUPABASE_SERVICE_ROLE_KEY_MISSING',
      'SUPABASE_SERVICE_ROLE_KEY is required for bot database access (there is no fallback to SUPABASE_ANON_KEY)'
    );
  }

  const role = readJwtRole(serviceRoleKey);
  if (role !== null && role !== 'service_role') {
    throw new SupabaseServerConfigError(
      'SUPABASE_KEY_NOT_SERVICE_ROLE',
      `SUPABASE_SERVICE_ROLE_KEY does not hold a service_role key (role claim: "${role}")`
    );
  }

  return { url, serviceRoleKey };
}

/**
 * PostgREST request headers for the bot's server-side calls.
 * @param {Object} [options]
 * @param {boolean} [options.json] add Content-Type: application/json
 * @param {Object} [options.extra] additional headers (e.g. Prefer)
 * @param {Object} [env]
 */
export function buildSupabaseRestHeaders({ json = false, extra = {} } = {}, env = process.env) {
  const { serviceRoleKey } = resolveSupabaseServiceConfig(env);
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`
  };
  if (json) headers['Content-Type'] = 'application/json';
  return { ...headers, ...extra };
}
