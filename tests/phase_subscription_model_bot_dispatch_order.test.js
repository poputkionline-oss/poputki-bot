/**
 * tests/phase_subscription_model_bot_dispatch_order.test.js
 *
 * POPUTKI.ONLINE — Manual Booking Telegram Subscription Model.
 *
 * Executable (not source-regex) regression coverage for the real dispatcher
 * order in api/bot-claim.js's default handler().
 *
 * History: a second production incident on booking_id=486 showed a
 * contact-share still reaching the old claim/mismatch flow after an earlier
 * fix (clearing claim state on successful subscribe bind, e0b9d62) had
 * already been deployed — that fix only closed the specific case where the
 * SAME /start subscribe_<token> request that bound the session also cleared
 * the stale state. The follow-up fix (9bf0192) made the subscription check
 * run before ANY claim-state check, closing that race — but a review of
 * that commit found it made the ordinary, already-working legacy claim flow
 * depend on the subscription backend being reachable at all, which it never
 * did before: a network hiccup checking for an active subscription session
 * would show a generic error instead of ever running the claim flow, even
 * for a contact share that had nothing to do with subscriptions.
 *
 * The current design (this file) restores that independence: claim state is
 * read first (cheap, always was), the subscription check still always runs
 * (so an active session still wins the race), but an ambiguous/error
 * outcome from the subscription check now fails OPEN toward an
 * already-active claim conversation instead of blocking it — only a
 * definitive 'not_pending' or 'consumed' answer changes what runs.
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

// bot_user_states GET routes are keyed by the exact state=eq.<value> query
// param — a real PostgREST backend filters server-side, so a mock that
// matched on table name alone would answer the SAME canned row for both the
// claim-state check AND the (separate) subscribe-pending-marker check,
// silently making them indistinguishable in tests.
const CLAIM_STATE_GET_ROUTE = (sessionId = 'real-claim-session') => ({
    match: (url, opts) => url.includes('/rest/v1/bot_user_states') && url.includes('state=eq.waiting_for_ticket_claim_contact') && (!opts.method || opts.method === 'GET'),
    respond: () => jsonResponse(200, [{ state: 'waiting_for_ticket_claim_contact', data: { session_id: sessionId, expires_at: '2026-09-13T00:00:00Z' } }])
});

const NO_CLAIM_STATE_GET_ROUTE = {
    match: (url, opts) => url.includes('/rest/v1/bot_user_states') && url.includes('state=eq.waiting_for_ticket_claim_contact') && (!opts.method || opts.method === 'GET'),
    respond: () => jsonResponse(200, [])
};

// Default: no subscribe-pending marker. Tests that need one present pass
// SUBSCRIBE_PENDING_MARKER_GET_ROUTE(true) instead.
const SUBSCRIBE_PENDING_MARKER_GET_ROUTE = (present = false) => ({
    match: (url, opts) => url.includes('/rest/v1/bot_user_states') && url.includes('state=eq.subscribe_pending_contact') && (!opts.method || opts.method === 'GET'),
    respond: () => jsonResponse(200, present
        ? [{ state: 'subscribe_pending_contact', data: { expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() } }]
        : [])
});

const CLAIM_STATE_DELETE_ROUTE = {
    match: (url, opts) => url.includes('/rest/v1/bot_user_states') && opts.method === 'DELETE',
    respond: () => jsonResponse(200, {})
};

const SUBSCRIBE_PENDING_MARKER_POST_ROUTE = {
    match: (url, opts) => url.includes('/rest/v1/bot_user_states') && opts.method === 'POST',
    respond: () => jsonResponse(201, {})
};

describe('bot-claim.js handler() — real dispatcher order via contact-share', () => {
    let handler, resetCache;

    beforeEach(async () => {
        setTestEnv();
        // ES module imports are cached, so the module-level FEATURE_DISABLED
        // cache in attemptSubscribeFromContact would otherwise leak between
        // test cases in this file — reset it explicitly every time.
        ({ default: handler, __resetSubscribeCheckCacheForTests: resetCache } = await import('../api/bot-claim.js'));
        resetCache();
    });

    afterEach(() => {
        global.fetch = ORIGINAL_FETCH;
        restoreEnv();
    });

    it('RACE: a stale claim state AND an active bound subscription session both exist — the contact completes the subscription; /claims/bot/verify-and-claim (old claim flow) is never called', async () => {
        const fetchMock = makeFetchMock([
            TELEGRAM_SEND_ROUTE,
            CLAIM_STATE_GET_ROUTE('stale-session-id'),
            {
                match: (url, opts) => url.includes('/claims/bot/subscribe') && opts.method === 'POST',
                respond: () => jsonResponse(200, {
                    success: true,
                    trip: { fromCity: 'Душанбе', toCity: 'Худжанд', departureDate: '2026-09-20', departureTime: '08:00:00', seatNumbers: '[12]' }
                })
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
        assert.ok(!fetchMock.calledWith('/claims/bot/verify-and-claim'), 'legacy claim endpoint must never be called');

        const sendCall = fetchMock.calls.find(c => c.url.includes('/sendMessage'));
        assert.ok(sendCall.body.text.includes('Билет добавлен в Telegram'), 'user must see the subscribe-success message, not a claim message');
    });

    it('normal claim_/s_ scenario: no active subscription session (backend reports FEATURE_DISABLED) — falls through to the legacy claim flow exactly as before', async () => {
        const fetchMock = makeFetchMock([
            TELEGRAM_SEND_ROUTE,
            CLAIM_STATE_GET_ROUTE('real-claim-session'),
            CLAIM_STATE_DELETE_ROUTE,
            {
                match: (url, opts) => url.includes('/claims/bot/subscribe') && opts.method === 'POST',
                respond: () => jsonResponse(404, { error: 'NOT_FOUND', code: 'FEATURE_DISABLED' })
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
        assert.ok(fetchMock.calledWith('/claims/bot/subscribe'), 'subscription check must still run');
        assert.ok(fetchMock.calledWith('/claims/bot/verify-and-claim'), 'legacy claim flow must still complete normally');

        const sendCalls = fetchMock.calls.filter(c => c.url.includes('/sendMessage'));
        const finalMessage = sendCalls[sendCalls.length - 1];
        assert.ok(finalMessage.body.text.includes('Билет успешно добавлен'), 'user must see the claim-success message');
    });

    it('RELIABILITY: an ambiguous/network error from the subscribe check, with NO subscribe-pending marker, must NOT block an already-active claim conversation — fails open to the claim flow', async () => {
        const fetchMock = makeFetchMock([
            TELEGRAM_SEND_ROUTE,
            CLAIM_STATE_GET_ROUTE('real-claim-session'),
            SUBSCRIBE_PENDING_MARKER_GET_ROUTE(false),
            CLAIM_STATE_DELETE_ROUTE,
            {
                match: (url, opts) => url.includes('/claims/bot/subscribe') && opts.method === 'POST',
                respond: () => jsonResponse(500, { error: 'Не удалось добавить билет в Telegram', code: 'SUBSCRIBE_FAILED' })
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
        assert.ok(fetchMock.calledWith('/claims/bot/subscribe'), 'subscription check must still be attempted');
        assert.ok(fetchMock.calledWith('/claims/bot/verify-and-claim'), 'an ambiguous subscribe-check error with no marker must fail OPEN toward the already-active claim flow, not block it');

        const sendCalls = fetchMock.calls.filter(c => c.url.includes('/sendMessage'));
        const finalMessage = sendCalls[sendCalls.length - 1];
        assert.ok(finalMessage.body.text.includes('Билет успешно добавлен'), 'user must see the claim flow complete normally despite the subscribe-check error');
    });

    it('SAFETY: an ambiguous/network error from the subscribe check WITH a subscribe-pending marker present must NOT fail open — a genuine subscribe attempt must never be silently completed as someone else\'s claim', async () => {
        const fetchMock = makeFetchMock([
            TELEGRAM_SEND_ROUTE,
            CLAIM_STATE_GET_ROUTE('real-claim-session'),
            SUBSCRIBE_PENDING_MARKER_GET_ROUTE(true),
            {
                match: (url, opts) => url.includes('/claims/bot/subscribe') && opts.method === 'POST',
                respond: () => jsonResponse(500, { error: 'Не удалось добавить билет в Telegram', code: 'SUBSCRIBE_FAILED' })
            },
            {
                match: (url) => url.includes('/claims/bot/verify-and-claim'),
                respond: () => { throw new Error('must never complete a claim when a subscribe-pending marker shows a real subscribe attempt is likely in flight'); }
            }
        ]);
        global.fetch = fetchMock;

        const res = makeRes();
        await handler({ method: 'POST', body: { message: makeContactMessage() } }, res);

        assert.equal(res.statusCode, 200);
        assert.ok(fetchMock.calledWith('/claims/bot/subscribe'));
        assert.ok(!fetchMock.calledWith('/claims/bot/verify-and-claim'), 'claim flow must not run when a subscribe-pending marker is present');

        const sendCall = fetchMock.calls.find(c => c.url.includes('/sendMessage'));
        assert.ok(sendCall.body.text.includes('Попробуйте ещё раз'), 'user must see the generic subscribe retry message, not a silently-completed claim');
    });

    it('an ambiguous/network error from the subscribe check with NO claim state to fail open to just shows the generic retry message', async () => {
        const fetchMock = makeFetchMock([
            TELEGRAM_SEND_ROUTE,
            NO_CLAIM_STATE_GET_ROUTE,
            {
                match: (url, opts) => url.includes('/claims/bot/subscribe') && opts.method === 'POST',
                respond: () => jsonResponse(500, { error: 'Не удалось добавить билет в Telegram', code: 'SUBSCRIBE_FAILED' })
            },
            {
                match: (url) => url.includes('/claims/bot/verify-and-claim'),
                respond: () => { throw new Error('there is no claim state here — the claim endpoint must never be called'); }
            }
        ]);
        global.fetch = fetchMock;

        const res = makeRes();
        await handler({ method: 'POST', body: { message: makeContactMessage() } }, res);

        assert.equal(res.statusCode, 200);
        const sendCall = fetchMock.calls.find(c => c.url.includes('/sendMessage'));
        assert.ok(sendCall.body.text.includes('Попробуйте ещё раз'), 'user must see a generic retry message');
    });

    it('BOOKING_NOT_SUBSCRIBABLE from an active session is reported directly — the legacy claim flow is never consulted even if claim state exists', async () => {
        const fetchMock = makeFetchMock([
            TELEGRAM_SEND_ROUTE,
            CLAIM_STATE_GET_ROUTE('real-claim-session'),
            {
                match: (url, opts) => url.includes('/claims/bot/subscribe') && opts.method === 'POST',
                respond: () => jsonResponse(400, { error: 'Не удалось создать сессию подписки', code: 'BOOKING_NOT_SUBSCRIBABLE' })
            },
            {
                match: (url) => url.includes('/claims/bot/verify-and-claim'),
                respond: () => { throw new Error('claim flow must never be consulted when an active session was found but not subscribable'); }
            }
        ]);
        global.fetch = fetchMock;

        const res = makeRes();
        await handler({ method: 'POST', body: { message: makeContactMessage() } }, res);

        assert.equal(res.statusCode, 200);
        const sendCall = fetchMock.calls.find(c => c.url.includes('/sendMessage'));
        assert.ok(sendCall.body.text.includes('больше недоступна для подписки'));
    });

    it('CACHE: once the backend reports FEATURE_DISABLED, a second contact share within the TTL never calls the subscribe endpoint again, but still runs the claim flow normally', async () => {
        let subscribeCalls = 0;
        const fetchMock = makeFetchMock([
            TELEGRAM_SEND_ROUTE,
            CLAIM_STATE_GET_ROUTE('real-claim-session'),
            CLAIM_STATE_DELETE_ROUTE,
            {
                match: (url, opts) => url.includes('/claims/bot/subscribe') && opts.method === 'POST',
                respond: () => { subscribeCalls++; return jsonResponse(404, { error: 'NOT_FOUND', code: 'FEATURE_DISABLED' }); }
            },
            {
                match: (url, opts) => url.includes('/claims/bot/verify-and-claim') && opts.method === 'POST',
                respond: () => jsonResponse(200, { status: 'claimed' })
            }
        ]);
        global.fetch = fetchMock;

        const res1 = makeRes();
        await handler({ method: 'POST', body: { message: makeContactMessage({ chatId: 111, userId: 111 }) } }, res1);
        assert.equal(subscribeCalls, 1, 'first call must hit the real backend');

        const res2 = makeRes();
        await handler({ method: 'POST', body: { message: makeContactMessage({ chatId: 222, userId: 222 }) } }, res2);
        assert.equal(subscribeCalls, 1, 'second call within the TTL must be answered from the in-process cache, not a second network call');
        assert.equal(res2.statusCode, 200);

        const sendCalls = fetchMock.calls.filter(c => c.url.includes('/sendMessage'));
        assert.ok(sendCalls[sendCalls.length - 1].body.text.includes('Билет успешно добавлен'), 'the claim flow must still complete normally on the cached path');
    });
});
