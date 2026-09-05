import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { callAssistantChat } from '../utils/assistantChatClient.js';

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
});
