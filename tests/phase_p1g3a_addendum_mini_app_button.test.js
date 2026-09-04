/**
 * tests/phase_p1g3a_addendum_mini_app_button.test.js
 *
 * PHASE P.1G.3A ADDENDUM — /start Mini App button opens bus search
 *
 * Real audit finding: the /start button already used Telegram's `web_app`
 * field (not a plain `url`), but it pointed at the bare Mini App root
 * (MINI_APP_URL with no path), which behaves like opening the homepage from
 * the user's perspective. Fixed to point at /search?tab=bus - the allowlisted
 * deep-link value SearchResultsView.vue already supports (tab defaults to
 * the bus tab there too) - so the bot's primary CTA lands directly on the
 * bus search form instead of the landing page.
 *
 * Exercises the real handleGenericStart()/handleWebHandshake() against a
 * mocked global.fetch, asserting on the actual outgoing Telegram API request
 * body - not source-string matching.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

function withMockFetch(t, { telegramOk = true } = {}) {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
        calls.push({ url: String(url), body: options?.body ? JSON.parse(options.body) : null });
        if (String(url).includes('api.telegram.org')) {
            return { ok: telegramOk, json: async () => ({ ok: telegramOk }) };
        }
        return { ok: true, json: async () => ({ success: true }) };
    };
    t.after(() => { global.fetch = originalFetch; });
    return calls;
}

test('PHASE P.1G.3A ADDENDUM — handleGenericStart() Mini App button', async (t) => {
    const savedMiniAppUrl = process.env.MINI_APP_URL;
    process.env.MINI_APP_URL = 'https://www.poputki.online';
    process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test-bot-token';
    t.after(() => {
        if (savedMiniAppUrl === undefined) delete process.env.MINI_APP_URL;
        else process.env.MINI_APP_URL = savedMiniAppUrl;
    });

    await t.test('primary button uses web_app (Telegram Mini App), never a plain url field', async () => {
        const calls = withMockFetch(t);
        const { handleGenericStart } = await import(`../api/acquisitionBotHandler.js?t=${Date.now()}`);
        await handleGenericStart({ chat: { id: 1 }, from: { id: 42 } });

        const telegramCall = calls.find(c => c.url.includes('api.telegram.org'));
        assert.ok(telegramCall, 'must send a Telegram sendMessage request');
        const primaryButton = telegramCall.body.reply_markup.inline_keyboard[0][0];
        assert.ok(primaryButton.web_app, 'primary button must use web_app, not a plain url');
        assert.equal('url' in primaryButton, false, 'must not also set a competing plain url field');
    });

    await t.test('web_app url is HTTPS and opens the bus search tab', async () => {
        const calls = withMockFetch(t);
        const { handleGenericStart } = await import(`../api/acquisitionBotHandler.js?t=${Date.now()}`);
        await handleGenericStart({ chat: { id: 1 }, from: { id: 42 } });

        const telegramCall = calls.find(c => c.url.includes('api.telegram.org'));
        const primaryButton = telegramCall.body.reply_markup.inline_keyboard[0][0];
        const url = new URL(primaryButton.web_app.url);
        assert.equal(url.protocol, 'https:');
        assert.equal(url.pathname, '/search');
        assert.equal(url.searchParams.get('tab'), 'bus');
    });

    await t.test('button URL is derived from MINI_APP_URL configuration, not hardcoded', async () => {
        const savedAgain = process.env.MINI_APP_URL;
        process.env.MINI_APP_URL = 'https://staging.poputki.online';
        const calls = withMockFetch(t);
        const { handleGenericStart } = await import(`../api/acquisitionBotHandler.js?t=${Date.now()}`);
        await handleGenericStart({ chat: { id: 1 }, from: { id: 42 } });

        const telegramCall = calls.find(c => c.url.includes('api.telegram.org'));
        const primaryButton = telegramCall.body.reply_markup.inline_keyboard[0][0];
        assert.ok(primaryButton.web_app.url.startsWith('https://staging.poputki.online/search?tab=bus'));
        process.env.MINI_APP_URL = savedAgain;
    });

    await t.test('falls back to the official poputki.online domain when MINI_APP_URL is unset', async () => {
        const savedAgain = process.env.MINI_APP_URL;
        delete process.env.MINI_APP_URL;
        const calls = withMockFetch(t);
        const { handleGenericStart } = await import(`../api/acquisitionBotHandler.js?t=${Date.now()}`);
        await handleGenericStart({ chat: { id: 1 }, from: { id: 42 } });

        const telegramCall = calls.find(c => c.url.includes('api.telegram.org'));
        const primaryButton = telegramCall.body.reply_markup.inline_keyboard[0][0];
        assert.equal(primaryButton.web_app.url, 'https://poputki.online/search?tab=bus');
        process.env.MINI_APP_URL = savedAgain;
    });

    await t.test('button text is the bus-specific CTA, no longer the generic "Открыть POPUTKI.ONLINE"', async () => {
        const calls = withMockFetch(t);
        const { handleGenericStart } = await import(`../api/acquisitionBotHandler.js?t=${Date.now()}`);
        await handleGenericStart({ chat: { id: 1 }, from: { id: 42 } });

        const telegramCall = calls.find(c => c.url.includes('api.telegram.org'));
        const primaryButton = telegramCall.body.reply_markup.inline_keyboard[0][0];
        assert.equal(primaryButton.text, '🚌 Найти билет на автобус');
        assert.notEqual(primaryButton.text, '🚗 Открыть POPUTKI.ONLINE');
    });

    await t.test('"Мои билеты" button is preserved unchanged, still a distinct web_app target', async () => {
        const calls = withMockFetch(t);
        const { handleGenericStart } = await import(`../api/acquisitionBotHandler.js?t=${Date.now()}`);
        await handleGenericStart({ chat: { id: 1 }, from: { id: 42 } });

        const telegramCall = calls.find(c => c.url.includes('api.telegram.org'));
        const rows = telegramCall.body.reply_markup.inline_keyboard;
        const ticketsButton = rows.flat().find(b => b.text === '🎫 Мои билеты');
        const primaryButton = rows.flat().find(b => b.text === '🚌 Найти билет на автобус');
        assert.ok(ticketsButton, '"Мои билеты" button must still be present');
        assert.ok(ticketsButton.web_app, 'must still use web_app');
        assert.ok(ticketsButton.web_app.url.endsWith('/my-bus-tickets'));
        assert.notEqual(ticketsButton.web_app.url, primaryButton.web_app.url, 'must not collapse into the same URL as the primary button');
    });

    await t.test('there is exactly one primary CTA button (no duplicate main button)', async () => {
        const calls = withMockFetch(t);
        const { handleGenericStart } = await import(`../api/acquisitionBotHandler.js?t=${Date.now()}`);
        await handleGenericStart({ chat: { id: 1 }, from: { id: 42 } });

        const telegramCall = calls.find(c => c.url.includes('api.telegram.org'));
        const rows = telegramCall.body.reply_markup.inline_keyboard;
        const busSearchButtons = rows.flat().filter(b => b.web_app?.url?.includes('/search?tab=bus'));
        assert.equal(busSearchButtons.length, 1, 'must be exactly one bus-search button, not a duplicate');
    });

    await t.test('the message text carries an HTTPS fallback link to the same bus search URL (Telegram-client-without-WebApp-support safety net)', async () => {
        const calls = withMockFetch(t);
        const { handleGenericStart } = await import(`../api/acquisitionBotHandler.js?t=${Date.now()}`);
        await handleGenericStart({ chat: { id: 1 }, from: { id: 42 } });

        const telegramCall = calls.find(c => c.url.includes('api.telegram.org'));
        assert.ok(telegramCall.body.text.includes('https://www.poputki.online/search?tab=bus'));
    });

    await t.test('never leaks BOT_TOKEN or INTERNAL_SERVICE_SECRET in the message text or button payload', async () => {
        process.env.INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET || 'must-not-leak-secret-value';
        const calls = withMockFetch(t);
        const { handleGenericStart } = await import(`../api/acquisitionBotHandler.js?t=${Date.now()}`);
        await handleGenericStart({ chat: { id: 1 }, from: { id: 42 } });

        const telegramCall = calls.find(c => c.url.includes('api.telegram.org'));
        const payloadStr = JSON.stringify(telegramCall.body);
        assert.ok(!payloadStr.includes(process.env.BOT_TOKEN));
        assert.ok(!payloadStr.includes(process.env.INTERNAL_SERVICE_SECRET));
    });

    await t.test('brand welcome text is preserved', async () => {
        const calls = withMockFetch(t);
        const { handleGenericStart } = await import(`../api/acquisitionBotHandler.js?t=${Date.now()}`);
        await handleGenericStart({ chat: { id: 1 }, from: { id: 42 } });

        const telegramCall = calls.find(c => c.url.includes('api.telegram.org'));
        assert.ok(telegramCall.body.text.includes('Добро пожаловать в POPUTKI.ONLINE!'));
    });
});

test('PHASE P.1G.3A ADDENDUM — handleWebHandshake() also opens the bus search Mini App', async (t) => {
    process.env.MINI_APP_URL = 'https://www.poputki.online';
    process.env.BOT_TOKEN = process.env.BOT_TOKEN || 'test-bot-token';
    process.env.INTERNAL_SERVICE_SECRET = process.env.INTERNAL_SERVICE_SECRET || 'test-internal-secret';

    await t.test('successful handshake button opens the bus search tab via web_app', async () => {
        const calls = withMockFetch(t);
        const { handleWebHandshake } = await import(`../api/acquisitionBotHandler.js?t=${Date.now()}`);
        await handleWebHandshake({ chat: { id: 7 }, from: { id: 99 } }, 'w_test_token');

        const telegramCall = calls.find(c => c.url.includes('api.telegram.org'));
        const button = telegramCall.body.reply_markup.inline_keyboard[0][0];
        assert.ok(button.web_app);
        assert.equal(button.web_app.url, 'https://www.poputki.online/search?tab=bus');
    });
});
