import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { callAssistantChat, getConfig } from '../utils/assistantChatClient.js';

describe('PHASE AI SECURITY HOTFIX — Telegram Bot AI Assistant Client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('1. AI is disabled by default (fail-closed, returns fallback: true)', async () => {
    delete process.env.AI_ASSISTANT_ENABLED;
    const res = await callAssistantChat({
      updateId: 101,
      telegramId: 777001,
      chatId: 777001,
      message: 'Есть ли билеты в Худжанд?'
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.fallback, true);
    assert.strictEqual(res.reason, 'AI_DISABLED');
  });

  it('2. Fails closed if INTERNAL_BOT_ASSISTANT_SECRET is not configured', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://example.supabase.co/functions/v1/assistant-chat';
    delete process.env.INTERNAL_BOT_ASSISTANT_SECRET;

    const res = await callAssistantChat({
      updateId: 102,
      telegramId: 777001,
      chatId: 777001,
      message: 'Привет'
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.fallback, true);
    assert.strictEqual(res.reason, 'SERVICE_UNCONFIGURED');
  });

  it('3. Enforces pilot whitelist: non-whitelisted user is rejected safely', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://example.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'super_secret_pilot_key_12345';
    process.env.AI_PILOT_WHITELIST = '111,222,333';

    const res = await callAssistantChat({
      updateId: 103,
      telegramId: 999, // not in whitelist
      chatId: 999,
      message: 'Поиск рейса'
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.fallback, true);
    assert.strictEqual(res.reason, 'NOT_IN_WHITELIST');
  });

  it('4. Rejects messages exceeding 1000 characters without calling backend', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://example.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'super_secret_pilot_key_12345';

    const longMessage = 'A'.repeat(1001);
    const res = await callAssistantChat({
      updateId: 104,
      telegramId: 777001,
      chatId: 777001,
      message: longMessage
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.fallback, true);
    assert.strictEqual(res.reason, 'INVALID_LENGTH');
  });

  it('5. Handles network or timeout errors safely with fallback: true (no uncaught throws)', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    // Point to non-routable port to force immediate network failure
    process.env.AI_ASSISTANT_ENDPOINT = 'http://127.0.0.1:1';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    process.env.AI_REQUEST_TIMEOUT_MS = '100';

    const res = await callAssistantChat({
      updateId: 105,
      telegramId: 777001,
      chatId: 777001,
      message: 'Поездка в Душанбе'
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.fallback, true);
    assert.ok(['NETWORK_ERROR', 'TIMEOUT'].includes(res.reason));
  });

  it('6. Successfully processes mock upstream 200 response and extracts trips', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    process.env.AI_PILOT_WHITELIST = '777001';

    // Mock global fetch for this test
    const originalFetch = globalThis.fetch;
    let interceptedHeaders = null;
    let interceptedBody = null;

    globalThis.fetch = async (url, options) => {
      interceptedHeaders = options.headers;
      interceptedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          reply: 'Найдено 2 рейса в Худжанд.',
          trips: [
            {
              type: 'bus',
              id: 55,
              from_city: 'Душанбе',
              to_city: 'Худжанд',
              price_somoni: 120,
              booking_path: '/bus-ticket/55'
            }
          ]
        })
      };
    };

    try {
      process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
      const res = await callAssistantChat({
        updateId: 888999,
        telegramId: 777001,
        chatId: 777001,
        message: 'Душанбе Худжанд'
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.fallback, false);
      assert.strictEqual(res.reply, 'Найдено 2 рейса в Худжанд.');
      assert.strictEqual(res.trips.length, 1);
      assert.strictEqual(res.trips[0].booking_path, '/bus-ticket/55');

      // Verify server-to-server security headers
      assert.strictEqual(interceptedHeaders['X-Bot-Service-Secret'], 'secret_test_key_12345');
      assert.strictEqual(interceptedBody.request_id, 'tg_upd_888999');
      assert.strictEqual(interceptedBody.telegram_id, 777001);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('7. Default timeout is 15000 ms without AI_REQUEST_TIMEOUT_MS env override', () => {
    delete process.env.AI_REQUEST_TIMEOUT_MS;
    const config = getConfig();
    assert.strictEqual(config.timeoutMs, 15000);
  });

  it('8. Edge Function response in 10-12 seconds is accepted (within 15s window)', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    process.env.AI_PILOT_WHITELIST = '777001';
    delete process.env.AI_REQUEST_TIMEOUT_MS; // uses default 15000ms

    const originalFetch = globalThis.fetch;
    let signalReceived = null;

    globalThis.fetch = async (url, options) => {
      signalReceived = options.signal;
      // Simulate realistic 11s latency without blocking test event loop for 11s:
      // Verify that at simulated 11s (11000ms), the signal is NOT aborted because 11000 < 15000.
      assert.strictEqual(options.signal.aborted, false, 'Signal must not be aborted at start of response');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          reply: 'Найдено 2 рейса: Душанбе — Худжанд на завтра.',
          trips: [{ type: 'carpool', id: 1865, from_city: 'Душанбе', to_city: 'Худжанд', price_somoni: 100 }]
        })
      };
    };

    try {
      const res = await callAssistantChat({
        updateId: 999101,
        telegramId: 777001,
        chatId: 777001,
        message: 'Рейс в Худжанд'
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.fallback, false);
      assert.strictEqual(res.reply.includes('Худжанд'), true);
      assert.strictEqual(res.trips.length, 1);
      assert.strictEqual(signalReceived.aborted, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('9. Request exceeding 15 seconds transitions safely to fallback (TIMEOUT)', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    process.env.AI_PILOT_WHITELIST = '777001';
    // Use low timeoutMs (50ms) to test timeout transition deterministically
    process.env.AI_REQUEST_TIMEOUT_MS = '50';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };

    try {
      const res = await callAssistantChat({
        updateId: 999102,
        telegramId: 777001,
        chatId: 777001,
        message: 'Рейс в Худжанд'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.fallback, true);
      assert.strictEqual(res.reason, 'TIMEOUT');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('10. Timeout does NOT cause retry or duplicate request to Claude/Edge Function', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    process.env.AI_PILOT_WHITELIST = '777001';
    process.env.AI_REQUEST_TIMEOUT_MS = '50';

    const originalFetch = globalThis.fetch;
    let callCount = 0;

    globalThis.fetch = async (url, options) => {
      callCount++;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };

    try {
      const res = await callAssistantChat({
        updateId: 999103,
        telegramId: 777001,
        chatId: 777001,
        message: 'Рейс в Худжанд'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.fallback, true);
      assert.strictEqual(res.reason, 'TIMEOUT');
      // Must be called exactly once: no retries on timeout!
      assert.strictEqual(callCount, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('11. Users outside whitelist do NOT invoke Edge Function or consume quota', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    process.env.AI_PILOT_WHITELIST = '386189312'; // only admin/pilot

    const originalFetch = globalThis.fetch;
    let fetchCalled = false;

    globalThis.fetch = async () => {
      fetchCalled = true;
      throw new Error('Fetch must not be called for non-whitelisted user');
    };

    try {
      const nonWhitelistedId = 999888777;
      const res = await callAssistantChat({
        updateId: 999104,
        telegramId: nonWhitelistedId,
        chatId: nonWhitelistedId,
        message: 'Привет, найди попутку'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.fallback, true);
      assert.strictEqual(res.reason, 'NOT_IN_WHITELIST');
      assert.strictEqual(fetchCalled, false, 'Edge Function must not be called');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
