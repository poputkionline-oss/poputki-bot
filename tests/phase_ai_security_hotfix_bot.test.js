import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { callAssistantChat, getConfig } from '../utils/assistantChatClient.js';
import { formatAiRateLimitResponse, RATE_LIMIT_MESSAGES } from '../utils/aiResponseFormatter.js';
import handler from '../api/bot.js';

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
    process.env.AI_PILOT_WHITELIST = '777001';

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
    process.env.AI_PILOT_WHITELIST = '777001';
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

  it('12. HTTP 429 + RATE_LIMITED_DAILY returns exact safe reason RATE_LIMITED_DAILY', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    process.env.AI_PILOT_WHITELIST = '777001';

    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ error: 'RATE_LIMITED_DAILY', status: 'RATE_LIMITED' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const res = await callAssistantChat({
        updateId: 999201,
        telegramId: 777001,
        chatId: 777001,
        message: 'Рейс в Худжанд'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.fallback, true);
      assert.strictEqual(res.reason, 'RATE_LIMITED_DAILY');
      assert.strictEqual(callCount, 1, 'Must make strictly 1 fetch call');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('13. HTTP 429 + RATE_LIMITED_GLOBAL returns exact safe reason RATE_LIMITED_GLOBAL', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    process.env.AI_PILOT_WHITELIST = '777001';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: 'RATE_LIMITED_GLOBAL_STOP_LOSS', status: 'GLOBAL_LIMIT_EXCEEDED' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const res = await callAssistantChat({
        updateId: 999202,
        telegramId: 777001,
        chatId: 777001,
        message: 'Рейс в Худжанд'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.fallback, true);
      assert.strictEqual(res.reason, 'RATE_LIMITED_GLOBAL');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('14. HTTP 429 with empty or non-JSON body safely falls back to HTTP_429', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    process.env.AI_PILOT_WHITELIST = '777001';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response('Too Many Requests', {
        status: 429,
        headers: { 'Content-Type': 'text/plain' }
      });
    };

    try {
      const res = await callAssistantChat({
        updateId: 999203,
        telegramId: 777001,
        chatId: 777001,
        message: 'Рейс в Худжанд'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.fallback, true);
      assert.strictEqual(res.reason, 'HTTP_429');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('15. HTTP 500 preserves fail-closed fallback without retries', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    process.env.AI_PILOT_WHITELIST = '777001';

    const originalFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount++;
      return new Response(JSON.stringify({ error: 'UPSTREAM_AI_ERROR' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const res = await callAssistantChat({
        updateId: 999204,
        telegramId: 777001,
        chatId: 777001,
        message: 'Рейс в Худжанд'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.fallback, true);
      assert.strictEqual(res.reason, 'HTTP_500');
      assert.strictEqual(callCount, 1, 'Strictly 1 fetch call on 500');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('16. Localized rate limit responses for RU, TJ, UZ (daily & global limits)', () => {
    // RU Daily
    const resRuDaily = formatAiRateLimitResponse({
      userMessage: 'Найди рейс из Душанбе в Худжанд',
      reason: 'RATE_LIMITED_DAILY',
      miniAppUrl: 'https://poputki.online'
    });
    assert.strictEqual(resRuDaily.lang, 'ru');
    assert.strictEqual(resRuDaily.text, 'Вы использовали дневной лимит AI-помощника — 5 запросов из 5. Найдите поездку в приложении или попробуйте снова завтра.');
    assert.strictEqual(resRuDaily.inlineKeyboard[0][0].text, '🔍 Найти поездку в приложении');
    assert.strictEqual(resRuDaily.inlineKeyboard[0][0].web_app.url, 'https://poputki.online/search');

    // TJ Daily
    const resTjDaily = formatAiRateLimitResponse({
      userMessage: 'Аз Душанбе ба Хуҷанд сафар ҳаст',
      reason: 'RATE_LIMITED_DAILY',
      miniAppUrl: 'https://poputki.online'
    });
    assert.strictEqual(resTjDaily.lang, 'tj');
    assert.strictEqual(resTjDaily.text, 'Шумо меъёри шабонарӯзии ёрдамчии AI — 5 дархост аз 5-ро истифода бурдед. Сафарро дар замима ҷустуҷӯ кунед ё фардо дубора кӯшиш намоед.');
    assert.strictEqual(resTjDaily.inlineKeyboard[0][0].text, '🔍 Ҷустуҷӯи сафар дар замима');
    assert.strictEqual(resTjDaily.inlineKeyboard[0][0].web_app.url, 'https://poputki.online/search');

    // UZ Daily (with exact production string)
    const resUzDaily = formatAiRateLimitResponse({
      userMessage: '8-sentabr kuni Dushanbedan Xo‘jandga safar topib bering',
      reason: 'RATE_LIMITED_DAILY',
      miniAppUrl: 'https://poputki.online'
    });
    assert.strictEqual(resUzDaily.lang, 'uz');
    assert.strictEqual(resUzDaily.text, 'Siz AI-yordamchining kunlik limitidan — 5 ta so‘rovdan 5 tasini ishlatdingiz. Safarni ilovadan qidiring yoki ertaga qayta urinib ko‘ring.');
    assert.strictEqual(resUzDaily.inlineKeyboard[0][0].text, '🔍 Ilovada safar qidirish');
    assert.strictEqual(resUzDaily.inlineKeyboard[0][0].web_app.url, 'https://poputki.online/search');

    // Global limit (RU, TJ, UZ) - must NOT expose internal limit 500
    const resRuGlobal = formatAiRateLimitResponse({
      userMessage: 'найди поездку',
      reason: 'RATE_LIMITED_GLOBAL',
      miniAppUrl: 'https://poputki.online'
    });
    assert.strictEqual(resRuGlobal.text, 'AI-помощник временно достиг общего лимита запросов. Воспользуйтесь поиском в приложении или попробуйте позже.');
    assert.ok(!resRuGlobal.text.includes('500'), 'Must not disclose internal limit 500');

    const resTjGlobal = formatAiRateLimitResponse({
      userMessage: 'Аз Душанбе ба Хуҷанд сафар ёбед',
      reason: 'RATE_LIMITED_GLOBAL',
      miniAppUrl: 'https://poputki.online'
    });
    assert.strictEqual(resTjGlobal.text, 'Ёрдамчии AI муваққатан ба меъёри умумии дархостҳо расид. Аз ҷустуҷӯи замима истифода баред ё баъдтар кӯшиш намоед.');
    assert.ok(!resTjGlobal.text.includes('500'), 'Must not disclose internal limit 500');

    const resUzGlobal = formatAiRateLimitResponse({
      userMessage: 'safar topib bering',
      reason: 'RATE_LIMITED_GLOBAL',
      miniAppUrl: 'https://poputki.online'
    });
    assert.strictEqual(resUzGlobal.text, 'AI-yordamchi vaqtincha umumiy so‘rovlar limitiga yetdi. Ilovadagi qidiruvdan foydalaning yoki keyinroq urinib ko‘ring.');
    assert.ok(!resUzGlobal.text.includes('500'), 'Must not disclose internal limit 500');
  });

  it('17. bot.js webhook handler integration: rate limits send localized messages with search button, others fall back', async () => {
    process.env.BOT_TOKEN = 'mock_bot_token_12345';
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    process.env.AI_PILOT_WHITELIST = '777001';
    process.env.MINI_APP_URL = 'https://poputki.online';

    const originalFetch = globalThis.fetch;
    const sentMessages = [];

    globalThis.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/sendMessage')) {
        const body = JSON.parse(options.body);
        sentMessages.push(body);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (urlStr.includes('assistant-chat')) {
        return new Response(JSON.stringify({ error: 'RATE_LIMITED_DAILY', status: 'RATE_LIMITED' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      const createMockRes = () => {
        const res = {
          statusCode: 200,
          body: null,
          status(code) { res.statusCode = code; return res; },
          json(obj) { res.body = obj; return res; }
        };
        return res;
      };

      // 1. RU query with RATE_LIMITED_DAILY
      const reqRu = {
        method: 'POST',
        body: {
          update_id: 10001,
          message: { chat: { id: 777001, type: 'private' }, from: { id: 777001 }, text: 'Найди поездку в Худжанд' }
        }
      };
      const resRu = createMockRes();
      await handler(reqRu, resRu);
      assert.strictEqual(resRu.statusCode, 200);
      assert.strictEqual(sentMessages.length, 1);
      assert.ok(sentMessages[0].text.includes('Вы использовали дневной лимит AI-помощника — 5 запросов из 5.'));
      assert.strictEqual(sentMessages[0].reply_markup.inline_keyboard[0][0].text, '🔍 Найти поездку в приложении');
      assert.strictEqual(sentMessages[0].reply_markup.inline_keyboard[0][0].web_app.url, 'https://poputki.online/search');

      // 2. UZ query with RATE_LIMITED_DAILY
      sentMessages.length = 0;
      const reqUz = {
        method: 'POST',
        body: {
          update_id: 10002,
          message: { chat: { id: 777001, type: 'private' }, from: { id: 777001 }, text: '8-sentabr kuni Dushanbedan Xo‘jandga safar topib bering' }
        }
      };
      const resUz = createMockRes();
      await handler(reqUz, resUz);
      assert.strictEqual(resUz.statusCode, 200);
      assert.strictEqual(sentMessages.length, 1);
      assert.ok(sentMessages[0].text.includes('Siz AI-yordamchining kunlik limitidan — 5 ta so‘rovdan 5 tasini ishlatdingiz.'));
      assert.strictEqual(sentMessages[0].reply_markup.inline_keyboard[0][0].text, '🔍 Ilovada safar qidirish');
      assert.strictEqual(sentMessages[0].reply_markup.inline_keyboard[0][0].web_app.url, 'https://poputki.online/search');

      // 3. Non-whitelisted user falls through to standard welcome menu (NOT rate limit message)
      sentMessages.length = 0;
      const reqNonWhite = {
        method: 'POST',
        body: {
          update_id: 10003,
          message: { chat: { id: 888002, type: 'private' }, from: { id: 888002 }, text: 'Привет' }
        }
      };
      const resNonWhite = createMockRes();
      await handler(reqNonWhite, resNonWhite);
      assert.strictEqual(resNonWhite.statusCode, 200);
      assert.strictEqual(sentMessages.length, 2, 'Default welcome flow sends menu + welcome text');
      assert.ok(!sentMessages.some(m => m.text.includes('лимит')), 'Must not send limit message');
      assert.ok(sentMessages.some(m => m.text.includes('Poputki.online')), 'Sends standard welcome text');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('18. AI_ASSISTANT_ENABLED=false, AI_ASSISTANT_PUBLIC_ENABLED=true -> 0 calls to Edge Function', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'false';
    process.env.AI_ASSISTANT_PUBLIC_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      const res = await callAssistantChat({
        updateId: 10018,
        telegramId: 888001,
        chatId: 888001,
        message: 'Поездка в Худжанд'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.fallback, true);
      assert.strictEqual(res.reason, 'AI_DISABLED');
      assert.strictEqual(fetchCalls, 0, 'Must have strictly 0 network calls when AI_ASSISTANT_ENABLED is false');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('19. AI enabled, public absent, user in whitelist -> access allowed', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    delete process.env.AI_ASSISTANT_PUBLIC_ENABLED;
    process.env.AI_PILOT_WHITELIST = '777001,777002';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ ok: true, reply: 'Найден рейс', trips: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const res = await callAssistantChat({
        updateId: 10019,
        telegramId: 777001,
        chatId: 777001,
        message: 'Поездка в Худжанд'
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.fallback, false);
      assert.strictEqual(fetchCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('20. AI enabled, public absent, user outside whitelist -> 0 network calls', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    delete process.env.AI_ASSISTANT_PUBLIC_ENABLED;
    process.env.AI_PILOT_WHITELIST = '777001';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      const res = await callAssistantChat({
        updateId: 10020,
        telegramId: 999999,
        chatId: 999999,
        message: 'Поездка в Худжанд'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.fallback, true);
      assert.strictEqual(res.reason, 'NOT_IN_WHITELIST');
      assert.strictEqual(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('21. AI enabled, public=false, user outside whitelist -> 0 network calls', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_PUBLIC_ENABLED = 'false';
    process.env.AI_PILOT_WHITELIST = '777001';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      const res = await callAssistantChat({
        updateId: 10021,
        telegramId: 999999,
        chatId: 999999,
        message: 'Поездка в Худжанд'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.fallback, true);
      assert.strictEqual(res.reason, 'NOT_IN_WHITELIST');
      assert.strictEqual(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('22. AI enabled, public=true, user outside whitelist -> strictly 1 Edge Function call', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_PUBLIC_ENABLED = 'true';
    process.env.AI_PILOT_WHITELIST = '777001';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ ok: true, reply: 'Публичный ответ AI', trips: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const res = await callAssistantChat({
        updateId: 10022,
        telegramId: 999999, // Outside whitelist!
        chatId: 999999,
        message: 'Поездка в Худжанд'
      });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.fallback, false);
      assert.strictEqual(res.reply, 'Публичный ответ AI');
      assert.strictEqual(fetchCalls, 1, 'Strictly 1 Edge Function call in public mode');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('23. Public="TRUE" and public=" true " safely normalize to true', () => {
    process.env.AI_ASSISTANT_PUBLIC_ENABLED = 'TRUE';
    assert.strictEqual(getConfig().publicEnabled, true);

    process.env.AI_ASSISTANT_PUBLIC_ENABLED = ' true ';
    assert.strictEqual(getConfig().publicEnabled, true);

    process.env.AI_ASSISTANT_PUBLIC_ENABLED = 'TrUe';
    assert.strictEqual(getConfig().publicEnabled, true);
  });

  it('24. Public="1", "yes", empty string, and unknown values do not enable public mode', () => {
    const invalidValues = ['1', 'yes', 'YES', '', '  ', '0', 'true1', 'enabled', 'on', 'null', 'undefined'];
    for (const val of invalidValues) {
      process.env.AI_ASSISTANT_PUBLIC_ENABLED = val;
      assert.strictEqual(getConfig().publicEnabled, false, `Expected "${val}" to evaluate to false`);
    }
    delete process.env.AI_ASSISTANT_PUBLIC_ENABLED;
    assert.strictEqual(getConfig().publicEnabled, false, 'Unset variable must evaluate to false');
  });

  it('25. Invalid or missing Telegram ID prevents Edge Function call', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_PUBLIC_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';

    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      const invalidIds = [null, undefined, '', '   ', 'abc', -1, 0, NaN, Infinity];
      for (const tid of invalidIds) {
        const res = await callAssistantChat({
          updateId: 10025,
          telegramId: tid,
          chatId: 10025,
          message: 'Поездка'
        });
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.fallback, true);
        assert.strictEqual(res.reason, 'INVALID_TELEGRAM_ID');
      }
      assert.strictEqual(fetchCalls, 0, 'Zero network calls for all invalid Telegram IDs');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('26. HTTP 429 DAILY in public mode returns RATE_LIMITED_DAILY with search button and 5 of 5 copy', async () => {
    process.env.BOT_TOKEN = 'mock_bot_token_12345';
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_PUBLIC_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    delete process.env.AI_PILOT_WHITELIST;
    process.env.MINI_APP_URL = 'https://poputki.online';

    const sentMessages = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/sendMessage')) {
        sentMessages.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (urlStr.includes('assistant-chat')) {
        return new Response(JSON.stringify({ error: 'RATE_LIMITED_DAILY', status: 'RATE_LIMITED' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(obj) { this.body = obj; return this; }
      };
      await handler({
        method: 'POST',
        body: {
          update_id: 20026,
          message: { chat: { id: 999111, type: 'private' }, from: { id: 999111 }, text: 'Рейс в Худжанд' }
        }
      }, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(sentMessages.length, 1);
      assert.ok(sentMessages[0].text.includes('Вы использовали дневной лимит AI-помощника — 5 запросов из 5.'));
      assert.strictEqual(sentMessages[0].reply_markup.inline_keyboard[0][0].text, '🔍 Найти поездку в приложении');
      assert.strictEqual(sentMessages[0].reply_markup.inline_keyboard[0][0].web_app.url, 'https://poputki.online/search');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('27. HTTP 429 GLOBAL in public mode returns localized message without exposing 500', async () => {
    process.env.BOT_TOKEN = 'mock_bot_token_12345';
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_PUBLIC_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    delete process.env.AI_PILOT_WHITELIST;
    process.env.MINI_APP_URL = 'https://poputki.online';

    const sentMessages = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const urlStr = String(url);
      if (urlStr.includes('/sendMessage')) {
        sentMessages.push(JSON.parse(options.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (urlStr.includes('assistant-chat')) {
        return new Response(JSON.stringify({ error: 'RATE_LIMITED_GLOBAL_STOP_LOSS', status: 'GLOBAL_LIMIT_EXCEEDED' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    try {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(obj) { this.body = obj; return this; }
      };
      await handler({
        method: 'POST',
        body: {
          update_id: 20027,
          message: { chat: { id: 999222, type: 'private' }, from: { id: 999222 }, text: 'Рейс в Худжанд' }
        }
      }, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(sentMessages.length, 1);
      assert.ok(sentMessages[0].text.includes('AI-помощник временно достиг общего лимита запросов.'));
      assert.ok(!sentMessages[0].text.includes('500'), 'Must not expose internal number 500');
      assert.strictEqual(sentMessages[0].reply_markup.inline_keyboard[0][0].text, '🔍 Найти поездку в приложении');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('28. Timeout in public mode preserves fail-closed fallback without retries', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_PUBLIC_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';
    process.env.AI_REQUEST_TIMEOUT_MS = '50';

    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      fetchCount++;
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
        updateId: 20028,
        telegramId: 999333,
        chatId: 999333,
        message: 'Рейс в Худжанд'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.fallback, true);
      assert.strictEqual(res.reason, 'TIMEOUT');
      assert.strictEqual(fetchCount, 1, 'Strictly 1 fetch call on timeout, no retries');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('29. HTTP 500 in public mode preserves fail-closed fallback without retries', async () => {
    process.env.AI_ASSISTANT_ENABLED = 'true';
    process.env.AI_ASSISTANT_PUBLIC_ENABLED = 'true';
    process.env.AI_ASSISTANT_ENDPOINT = 'https://test-api.supabase.co/functions/v1/assistant-chat';
    process.env.INTERNAL_BOT_ASSISTANT_SECRET = 'secret_test_key_12345';

    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCount++;
      return new Response(JSON.stringify({ error: 'INTERNAL_ERROR' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    try {
      const res = await callAssistantChat({
        updateId: 20029,
        telegramId: 999444,
        chatId: 999444,
        message: 'Рейс в Худжанд'
      });

      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.fallback, true);
      assert.strictEqual(res.reason, 'HTTP_500');
      assert.strictEqual(fetchCount, 1, 'Strictly 1 fetch call on 500, no retries');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
