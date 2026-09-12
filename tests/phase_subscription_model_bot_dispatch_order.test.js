/**
 * tests/phase_subscription_model_bot_dispatch_order.test.js
 *
 * POPUTKI.ONLINE — Manual Booking Telegram Subscription Model.
 *
 * Executable (not source-regex) regression coverage for the real dispatcher
 * order in api/bot-claim.js's default handler(): a contact-share must be
 * offered to the subscription flow FIRST, unconditionally, and the legacy
 * claim flow (bot_user_states) must only ever be consulted once the backend
 * has positively confirmed nothing is pending for that telegram id.
 *
 * This exists because a second production incident on booking_id=486 showed
 * a contact-share still reaching the old claim/mismatch flow after an
 * earlier fix (clearing claim state on successful subscribe bind) had
 * already been deployed — that fix only closed the specific case where the
 * SAME /start subscribe_<token> request that bound the session also cleared
 * the stale state; it did nothing for a state written or refreshed AFTER
 * the bind (e.g. a claim_/s_ deep link opened after the subscribe bind, but
 * before the contact is shared). The dispatcher itself must not depend on
 * bot_user_states having been cleared at all.
 *
 * These tests exercise the real handler() by stubbing global.fetch, so they
 * fail if the source is ever reverted to checking claim state before (or
 * instead of) an active subscription session.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_FETCH = global.fetch;

function setTestEnv() {
    process.env.BOT_TOKEN = 'test-bot-token';
    process.env.BACKEND_API_URL = 'https://backend.test/api';
    process.env.CLAIM_BOT_SHARED_SECRET = 'test-claim-secret';
    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_ANON_KEY = 'test-anon-key';
    process.env.MINI_APP_URL = 'https://miniapp.test';
    delete process.env.INTERNAL_SERVICE_SECRET; // signedBackendPost fails closed, swallowed by its own .catch
}

function restoreEnv() {
    process.env = { ...ORIGINAL_ENV };
}

function jsonResponse(status, body) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    };
}

/**
 * A tiny call-recording fetch router. `routes` is an array of
 * { match: (url, opts) => boolean, respond: (url, opts) => response }
 * checked in order; the first match wins. Every call (matched or not) is
 * pushed to `calls` for assertions.
 */
function makeFetchMock(routes) {
    const calls = [];
    const fn = async (url, opts = {}) => {
        calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
        for (const route of routes) {
            if (route.match(String(url), opts)) {
                return route.respond(String(url), opts);
            }
        }
        // Unrecognized call in a test — fail loudly rather than silently
        // resolving, so a missing route can't masquerade as "not called".
        throw new Error(`Unmocked fetch call in test: ${opts.method || 'GET'} ${url}`);
    };
    fn.calls = calls;
    fn.calledWith = (substr) => calls.some(c => c.url.includes(substr));
    return fn;
}

function makeContactMessage({ chatId = 555, userId = 555 } = {}) {
    return {
        chat: { id: chatId, type: 'private' },
        contact: { user_id: userId, phone_number: '+992113448887' },
        from: { id: userId, first_name: 'Test', username: 'testuser' }
    };
}

function makeRes() {
    const res = {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(obj) { this.body = obj; return this; }
    };
    return res;
}

const TELEGRAM_SEND_ROUTE = {
    match: (url) => url.includes('api.telegram.org') && url.includes('/sendMessage'),
    respond: () => jsonResponse(200, { ok: true, result: {} })
};

describe('bot-claim.js handler() — real dispatcher order via contact-share', () => {
    let handler;

    beforeEach(async () => {
        setTestEnv();
        // Fresh module registry isn't available without --experimental-vm-modules
        // tricks; bot-claim.js has no top-level env reads, so re-using the
        // cached import across tests is safe as long as each test installs
        // its own global.fetch before calling handler().
        ({ default: handler } = await import('../api/bot-claim.js'));
    });

    afterEach(() => {
        global.fetch = ORIGINAL_FETCH;
        restoreEnv();
    });

    it('RACE: a stale claim state AND an active bound subscription session both exist — the contact completes the subscription; bot_user_states is never even queried; /claims/bot/verify-and-claim (old claim flow) is never called', async () => {
        const fetchMock = makeFetchMock([
            TELEGRAM_SEND_ROUTE,
            {
                match: (url, opts) => url.includes('/claims/bot/subscribe') && opts.method === 'POST',
                respond: () => jsonResponse(200, {
                    success: true,
                    trip: { fromCity: 'Душанбе', toCity: 'Худжанд', departureDate: '2026-09-20', departureTime: '08:00:00', seatNumbers: '[12]' }
                })
            },
            {
                // If the dispatcher regresses to checking claim state first,
                // this would return a stale-but-real claim row — proving the
                // race is genuinely present in this test, not absent by
                // construction.
                match: (url, opts) => url.includes('/rest/v1/bot_user_states') && (!opts.method || opts.method === 'GET'),
                respond: () => jsonResponse(200, [{ state: 'waiting_for_ticket_claim_contact', data: { session_id: 'stale-session-id', expires_at: '2026-09-13T00:00:00Z' } }])
            },
            {
                match: (url) => url.includes('/claims/bot/verify-and-claim'),
                respond: () => { throw new Error('claim flow must never be invoked when a subscription session is active'); }
            }
        ]);
        global.fetch = fetchMock;

        const res = makeRes();
        await handler({ method: 'POST', body: { message: makeContactMessage() } }, res);

        assert.equal(res.statusCode, 200);
        assert.ok(fetchMock.calledWith('/claims/bot/subscribe'), 'subscription endpoint must be called');
        assert.ok(!fetchMock.calledWith('/rest/v1/bot_user_states'), 'bot_user_states must never be queried once the subscription flow consumes the contact');
        assert.ok(!fetchMock.calledWith('/claims/bot/verify-and-claim'), 'legacy claim endpoint must never be called');

        const sendCall = fetchMock.calls.find(c => c.url.includes('/sendMessage'));
        assert.ok(sendCall.body.text.includes('Билет добавлен в Telegram'), 'user must see the subscribe-success message, not a claim message');
    });

    it('normal claim_/s_ scenario: no active subscription session (backend reports FEATURE_DISABLED) — falls through to the legacy claim flow exactly as before', async () => {
        const fetchMock = makeFetchMock([
            TELEGRAM_SEND_ROUTE,
            {
                match: (url, opts) => url.includes('/claims/bot/subscribe') && opts.method === 'POST',
                respond: () => jsonResponse(404, { error: 'NOT_FOUND', code: 'FEATURE_DISABLED' })
            },
            {
                match: (url, opts) => url.includes('/rest/v1/bot_user_states') && (!opts.method || opts.method === 'GET'),
                respond: () => jsonResponse(200, [{ state: 'waiting_for_ticket_claim_contact', data: { session_id: 'real-claim-session', expires_at: '2026-09-13T00:00:00Z' } }])
            },
            {
                match: (url, opts) => url.includes('/rest/v1/bot_user_states') && opts.method === 'DELETE',
                respond: () => jsonResponse(200, {})
            },
            {
                match: (url, opts) => url.includes('/claims/bot/verify-and-claim') && opts.method === 'POST',
                respond: () => jsonResponse(200, { status: 'claimed' })
            }
        ]);
        global.fetch = fetchMock;

        const res = makeRes();
        await handler({ method: 'POST', body: { message: makeContactMessage() } }, res);

        assert.equal(res.statusCode, 200);
        assert.ok(fetchMock.calledWith('/claims/bot/subscribe'), 'subscription check must still run first');
        assert.ok(fetchMock.calledWith('/rest/v1/bot_user_states'), 'claim state must be consulted once subscribe reports not_pending');
        assert.ok(fetchMock.calledWith('/claims/bot/verify-and-claim'), 'legacy claim flow must still complete normally');

        const sendCalls = fetchMock.calls.filter(c => c.url.includes('/sendMessage'));
        const finalMessage = sendCalls[sendCalls.length - 1];
        assert.ok(finalMessage.body.text.includes('Билет успешно добавлен'), 'user must see the claim-success message');
    });

    it('an ambiguous/unmapped backend error from the subscribe check must NOT be silently treated as not_pending — the legacy claim flow is never consulted even though a claim state exists', async () => {
        const fetchMock = makeFetchMock([
            TELEGRAM_SEND_ROUTE,
            {
                match: (url, opts) => url.includes('/claims/bot/subscribe') && opts.method === 'POST',
                respond: () => jsonResponse(500, { error: 'Не удалось добавить билет в Telegram', code: 'SUBSCRIBE_FAILED' })
            },
            {
                match: (url) => url.includes('/rest/v1/bot_user_states'),
                respond: () => { throw new Error('claim state must never be consulted on an ambiguous subscribe-check error'); }
            },
            {
                match: (url) => url.includes('/claims/bot/verify-and-claim'),
                respond: () => { throw new Error('claim flow must never run on an ambiguous subscribe-check error'); }
            }
        ]);
        global.fetch = fetchMock;

        const res = makeRes();
        await handler({ method: 'POST', body: { message: makeContactMessage() } }, res);

        assert.equal(res.statusCode, 200);
        assert.ok(fetchMock.calledWith('/claims/bot/subscribe'));
        assert.ok(!fetchMock.calledWith('/rest/v1/bot_user_states'));
        assert.ok(!fetchMock.calledWith('/claims/bot/verify-and-claim'));

        const sendCall = fetchMock.calls.find(c => c.url.includes('/sendMessage'));
        assert.ok(sendCall.body.text.includes('Попробуйте ещё раз'), 'user must see a generic retry message, not silence and not a misrouted claim message');
    });

    it('BOOKING_NOT_SUBSCRIBABLE from an active session is reported directly — the legacy claim flow is never consulted', async () => {
        const fetchMock = makeFetchMock([
            TELEGRAM_SEND_ROUTE,
            {
                match: (url, opts) => url.includes('/claims/bot/subscribe') && opts.method === 'POST',
                respond: () => jsonResponse(400, { error: 'Не удалось создать сессию подписки', code: 'BOOKING_NOT_SUBSCRIBABLE' })
            },
            {
                match: (url) => url.includes('/rest/v1/bot_user_states'),
                respond: () => { throw new Error('claim state must never be consulted when an active session was found but not subscribable'); }
            }
        ]);
        global.fetch = fetchMock;

        const res = makeRes();
        await handler({ method: 'POST', body: { message: makeContactMessage() } }, res);

        assert.equal(res.statusCode, 200);
        assert.ok(!fetchMock.calledWith('/rest/v1/bot_user_states'));
        const sendCall = fetchMock.calls.find(c => c.url.includes('/sendMessage'));
        assert.ok(sendCall.body.text.includes('больше недоступна для подписки'));
    });
});
