/**
 * tests/phase_security_v2_0b0_bot_service_role.test.js
 *
 * SECURITY V2.0B-0 — the bot's direct Supabase REST access uses the
 * SERVICE ROLE key only, fails closed when it is missing, never falls back to
 * the anon key and never logs or leaks the credential. Synthetic keys only.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SupabaseServerConfigError,
  resolveSupabaseServiceConfig,
  buildSupabaseRestHeaders
} from '../utils/supabaseServerConfig.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = 'synthetic-service-role-key-AAAA1111';
const ANON = 'synthetic-anon-key-BBBB2222';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (role) => `eyJ${b64({ alg: 'HS256' }).slice(3)}.${b64({ role, iss: 'supabase' })}.c3ludGhldGljLXNpZw`;

describe('bot Supabase config — service role selection (C)', () => {
  it('uses SUPABASE_SERVICE_ROLE_KEY and never the anon key', () => {
    const env = { SUPABASE_URL: 'https://x.supabase.test', SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON };
    const cfg = resolveSupabaseServiceConfig(env);
    assert.equal(cfg.serviceRoleKey, SERVICE);
    const h = buildSupabaseRestHeaders({ json: true, extra: { Prefer: 'return=minimal' } }, env);
    assert.equal(h.apikey, SERVICE);
    assert.equal(h.Authorization, `Bearer ${SERVICE}`);
    assert.equal(h['Content-Type'], 'application/json');
    assert.equal(h.Prefer, 'return=minimal');
    assert.ok(!JSON.stringify(h).includes(ANON));
  });

  it('accepts a service_role JWT-shaped key', () => {
    const key = fakeJwt('service_role');
    assert.equal(resolveSupabaseServiceConfig({ SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: key }).serviceRoleKey, key);
  });
});

describe('bot Supabase config — fail closed (D)', () => {
  it('missing service-role key throws even if an anon key is present (no fallback)', () => {
    const env = { SUPABASE_URL: 'https://x.supabase.test', SUPABASE_ANON_KEY: ANON };
    assert.throws(() => resolveSupabaseServiceConfig(env), (e) => e instanceof SupabaseServerConfigError && e.code === 'SUPABASE_SERVICE_ROLE_KEY_MISSING');
    assert.throws(() => buildSupabaseRestHeaders({}, env), (e) => e.code === 'SUPABASE_SERVICE_ROLE_KEY_MISSING');
  });

  it('blank key and missing URL fail closed', () => {
    assert.throws(() => resolveSupabaseServiceConfig({ SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: '   ' }), (e) => e.code === 'SUPABASE_SERVICE_ROLE_KEY_MISSING');
    assert.throws(() => resolveSupabaseServiceConfig({ SUPABASE_SERVICE_ROLE_KEY: SERVICE }), (e) => e.code === 'SUPABASE_URL_MISSING');
  });

  it('an anon-role JWT placed in the service-role variable is rejected, without echoing the key', () => {
    const anonJwt = fakeJwt('anon');
    let err;
    try { resolveSupabaseServiceConfig({ SUPABASE_URL: 'https://x', SUPABASE_SERVICE_ROLE_KEY: anonJwt }); } catch (e) { err = e; }
    assert.ok(err && err.code === 'SUPABASE_KEY_NOT_SERVICE_ROLE');
    assert.ok(!err.message.includes(anonJwt));
    assert.ok(!err.message.includes(anonJwt.split('.')[1]));
  });

  it('error messages never contain a configured key value (F)', () => {
    for (const env of [
      { SUPABASE_URL: 'https://x', SUPABASE_ANON_KEY: ANON },
      { SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON }
    ]) {
      try { resolveSupabaseServiceConfig(env); } catch (e) {
        assert.ok(!e.message.includes(SERVICE) && !e.message.includes(ANON));
      }
    }
  });
});

describe('bot handler — real api/bot.js dispatch (/start)', () => {
  const ORIGINAL_ENV = { ...process.env };
  const ORIGINAL_FETCH = globalThis.fetch;
  let calls, logs, origLog;

  beforeEach(() => {
    calls = []; logs = [];
    origLog = console.log;
    console.log = (...a) => { logs.push(a.map(String).join(' ')); };
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), method: opts.method || 'GET', headers: opts.headers || {} });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }), text: async () => '{}' };
    };
    process.env.BOT_TOKEN = 'synthetic-bot-token';
    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.MINI_APP_URL = 'https://miniapp.test';
    process.env.SUPABASE_ANON_KEY = ANON;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  afterEach(() => {
    console.log = origLog;
    globalThis.fetch = ORIGINAL_FETCH;
    process.env = { ...ORIGINAL_ENV };
  });

  async function runStart() {
    const { default: handler } = await import('../api/bot.js');
    const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, send(o) { this.body = o; return this; } };
    await handler({ method: 'POST', headers: {}, body: { message: { message_id: 1, chat: { id: 1, type: 'private' }, from: { id: 1, first_name: 'T' }, text: '/start' } } }, res);
    return res;
  }

  it('with the service-role key: Supabase REST calls carry the service key, never the anon key', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    const res = await runStart();
    assert.equal(res.code, 200);
    const db = calls.filter(c => c.url.startsWith('https://supabase.test/rest/v1/'));
    assert.ok(db.length >= 1);
    for (const c of db) {
      assert.equal(c.headers.apikey, SERVICE);
      assert.equal(c.headers.Authorization, `Bearer ${SERVICE}`);
      assert.notEqual(c.headers.apikey, ANON);
    }
  });

  it('without the service-role key (anon key present): NO Supabase call is made, /start still answers, anon is never used', async () => {
    const res = await runStart();
    assert.equal(res.code, 200);
    assert.equal(calls.filter(c => c.url.includes('/rest/v1/')).length, 0);
    for (const c of calls) {
      assert.ok(!JSON.stringify(c.headers).includes(ANON));
    }
  });

  it('never logs the credentials (F)', async () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    await runStart();
    const all = logs.join('\n');
    assert.ok(!all.includes(SERVICE) && !all.includes(ANON));
  });
});

describe('bot source hygiene (C/F)', () => {
  const files = ['api/bot.js', 'api/bot-claim.js', 'api/acquisitionBotHandler.js', 'api/debug.js', 'utils/assistantChatClient.js', 'utils/signedBackendClient.js', 'utils/purchasePollHandler.js', 'scripts/setup-webhook.js'];
  const src = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

  it('no code path reads SUPABASE_ANON_KEY (no anon / service-role fallback chains)', () => {
    for (const f of files) {
      const s = src(f);
      assert.ok(!/SUPABASE_ANON_KEY/.test(s), `${f} references SUPABASE_ANON_KEY`);
      assert.ok(!/SERVICE_ROLE_KEY\s*\|\|/.test(s) && !/\|\|\s*process\.env\.SUPABASE_[A-Z_]*KEY/.test(s), `${f} has a key fallback chain`);
    }
  });

  it('no hardcoded JWT / Supabase key literals in bot source', () => {
    for (const f of files.concat(['utils/supabaseServerConfig.js'])) {
      assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\.eyJ/.test(src(f)), `${f} contains a JWT-like literal`);
    }
  });

  it('log statements never print key variables', () => {
    for (const f of files) {
      for (const line of src(f).split('\n')) {
        if (/(log|console\.\w+)\(/.test(line)) {
          assert.ok(!/(serviceRoleKey|SUPABASE_SERVICE_ROLE_KEY|apikey)/i.test(line), `${f}: logs a key variable: ${line.trim()}`);
        }
      }
    }
  });
});
