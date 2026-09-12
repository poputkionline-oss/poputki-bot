/**
 * phase_subscription_model_bot.test.js
 *
 * POPUTKI.ONLINE — Manual Booking Telegram Subscription Model, bot side.
 *
 * Source-level checks in the same style as phase_e44_bot_claim_cta.test.js /
 * phase_e45_2_bot_claim_messages.test.js (this repo's established
 * convention for auditing api/bot-claim.js), plus direct unit tests of the
 * real parseDeepLink() for the subscribe_ prefix.
 *
 * Architecture under test (bind-then-complete-by-telegram-id): the raw
 * session token from a subscribe_<token> deep link is presented to the
 * backend exactly once, at /start time, via POST /claims/bot/subscribe/bind
 * — and is never written to any bot-side table (not bot_user_states, not a
 * dedicated bot_subscription_states table, which no longer exists at all).
 * From then on the pending subscription is addressed purely by the
 * Telegram-authenticated sender's id, so the contact-share step calls
 * POST /claims/bot/subscribe with no session token/id whatsoever.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeepLink } from '../utils/deepLinkParser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const botClaimPath = path.resolve(__dirname, '../api/bot-claim.js');
const content = fs.readFileSync(botClaimPath, 'utf8');

describe('parseDeepLink — subscribe_ prefix', () => {
    it('recognizes a well-formed subscribe_ payload', () => {
        const result = parseDeepLink('/start subscribe_0123456789abcdef0123456789abcdef');
        assert.equal(result.valid, true);
        assert.equal(result.type, 'subscribe');
        assert.equal(result.token, '0123456789abcdef0123456789abcdef');
    });

    it('subscribe_ and claim_ are structurally distinct types, never confused', () => {
        const subscribeResult = parseDeepLink('/start subscribe_0123456789abcdef0123456789abcdef');
        const claimResult = parseDeepLink('/start claim_0123456789abcdef0123456789abcdef');
        assert.notEqual(subscribeResult.type, claimResult.type);
    });

    it('a subscribe_ token with the wrong length/charset is rejected (falls through to unrecognized)', () => {
        const shortResult = parseDeepLink('/start subscribe_tooshort');
        assert.equal(shortResult.type, 'unrecognized');
        assert.equal(shortResult.valid, false);
    });

    it('before this change, subscribe_ links were silently swallowed as generic start — now they parse to a distinct, handled type', () => {
        const result = parseDeepLink('/start subscribe_0123456789abcdef0123456789abcdef');
        assert.notEqual(result.type, 'empty');
        assert.notEqual(result.type, 'unrecognized');
    });
});

describe('bot-claim.js — raw token is NEVER persisted anywhere after bind', () => {
    it('bot_subscription_states no longer exists anywhere in the file (the old raw-token-storage design is fully removed)', () => {
        assert.ok(!content.includes('bot_subscription_states'));
    });

    it('SUBSCRIBE_STATE / setSubscriptionState / getSubscriptionState / clearSubscriptionState are all gone', () => {
        assert.ok(!content.includes('SUBSCRIBE_STATE'));
        assert.ok(!/function setSubscriptionState/.test(content));
        assert.ok(!/function getSubscriptionState/.test(content));
        assert.ok(!/function clearSubscriptionState/.test(content));
    });

    it('handleSubscribeStart calls the bind endpoint, not any Supabase REST write, with the raw token', () => {
        const block = content.slice(
            content.indexOf('async function handleSubscribeStart'),
            content.indexOf('async function attemptSubscribeFromContact')
        );
        assert.ok(block.includes("backendPost('/claims/bot/subscribe/bind'"));
        assert.ok(block.includes('sessionToken: rawToken'));
        assert.ok(block.includes('telegramId: chatId'));
        assert.ok(!block.includes('/rest/v1/'));
    });

    it('the raw token variable (rawToken) never appears outside handleSubscribeStart\'s own function body', () => {
        const startBlock = content.slice(
            content.indexOf('async function handleSubscribeStart'),
            content.indexOf('async function attemptSubscribeFromContact')
        );
        const restOfFile = content.slice(0, content.indexOf('async function handleSubscribeStart'))
            + content.slice(content.indexOf('async function attemptSubscribeFromContact'));
        // handleSubscribeStart's own parameter name is "rawToken" (fine, it's
        // a local parameter, scoped to this function only) — what must NOT
        // happen is any OTHER function reading/writing a field/column named
        // rawToken/session_token, since there is no longer anywhere for it
        // to persist to.
        assert.ok(startBlock.includes('rawToken'));
        assert.ok(!restOfFile.includes('session_token'));
    });

    it('never logs the raw session token (no console.* call anywhere in bot-claim.js)', () => {
        assert.ok(!/console\.(log|error|warn|info)/.test(content));
    });
});

describe('bot-claim.js — attemptSubscribeFromContact takes no session token/id', () => {
    it('the request body to /claims/bot/subscribe carries only telegramUser/telegramContact, never a session token or id', () => {
        const block = content.slice(
            content.indexOf('async function attemptSubscribeFromContact'),
            content.indexOf('async function handleUnsubscribeCommand')
        );
        assert.ok(block.includes("backendPost('/claims/bot/subscribe'"));
        assert.ok(!block.includes('sessionToken'));
        assert.ok(!block.includes('sessionId'));
    });

    it('rejects a contact whose user_id differs from the sender before ever calling the backend, treating it as not_pending (not a subscribe attempt)', () => {
        const block = content.slice(
            content.indexOf('async function attemptSubscribeFromContact'),
            content.indexOf('async function handleUnsubscribeCommand')
        );
        assert.match(block, /String\(contact\.user_id\)\s*!==\s*String\(sender\.id\)/);
        assert.match(block, /return 'not_pending';/);
    });

    it('never calls /claims/bot/verify-and-claim (that is the separate, untouched online-claim flow)', () => {
        const block = content.slice(
            content.indexOf('async function attemptSubscribeFromContact'),
            content.indexOf('async function handleUnsubscribeCommand')
        );
        assert.ok(!block.includes('verify-and-claim'));
    });

    it('returns one of three named string outcomes, never a plain boolean — SESSION_INVALID_EXPIRED_OR_CONSUMED/FEATURE_DISABLED are the only two positive not_pending confirmations, BOOKING_NOT_SUBSCRIBABLE is consumed (reportable), and everything else (network/unmapped) is its own distinct error outcome', () => {
        const block = content.slice(
            content.indexOf('async function attemptSubscribeFromContact'),
            content.indexOf('async function handleUnsubscribeCommand')
        );
        assert.match(block, /notPendingCodes\s*=\s*new Set\(\['FEATURE_DISABLED',\s*'SESSION_INVALID_EXPIRED_OR_CONSUMED'\]\)/);
        const notPendingBranch = block.slice(
            block.indexOf('if (notPendingCodes.has(error.code))'),
            block.indexOf('if (notPendingCodes.has(error.code))') + 300
        );
        assert.match(notPendingBranch, /return 'not_pending';/);
        assert.match(block, /error\.code === 'BOOKING_NOT_SUBSCRIBABLE'/);
        assert.match(block, /return 'consumed';/);
        assert.match(block, /return 'error';/);
        // never a bare boolean return anywhere in this function
        assert.ok(!/return (true|false);/.test(block));
    });
});

describe('bot-claim.js — dispatcher wiring', () => {
    const dispatchBlock = content.slice(content.indexOf('// 2. Process Contact Sharing'), content.lastIndexOf('return baseHandler(req, res);'));

    it('reads claim state first, then always attempts the subscribe check regardless of whether claim state exists', () => {
        const claimReadIdx = dispatchBlock.indexOf('getClaimState(message.chat.id)');
        const hasClaimStateIdx = dispatchBlock.indexOf("hasClaimState = claimState?.state === CLAIM_STATE");
        const subscribeIdx = dispatchBlock.indexOf('attemptSubscribeFromContact(message)');
        assert.ok(claimReadIdx !== -1 && hasClaimStateIdx !== -1 && subscribeIdx !== -1);
        assert.ok(claimReadIdx < hasClaimStateIdx);
        assert.ok(hasClaimStateIdx < subscribeIdx);
    });

    it('a "consumed" outcome always stops the dispatcher, regardless of claim state', () => {
        const consumedIdx = dispatchBlock.indexOf("subscribeOutcome === 'consumed'");
        assert.ok(consumedIdx !== -1);
    });

    it('an "error" outcome fails OPEN toward an already-active claim conversation instead of blocking it', () => {
        const errorBlockIdx = dispatchBlock.indexOf("if (subscribeOutcome === 'error')");
        const errorBlock = dispatchBlock.slice(errorBlockIdx, errorBlockIdx + 300);
        assert.match(errorBlock, /if\s*\(hasClaimState\)\s*\{\s*await handleClaimContact\(message, claimState\);/);
    });

    it('"not_pending" still runs the claim flow when claim state exists, or generic handling otherwise', () => {
        const notPendingIdx = dispatchBlock.indexOf("// subscribeOutcome === 'not_pending'");
        const afterNotPending = dispatchBlock.slice(notPendingIdx);
        const claimCallIdx = afterNotPending.indexOf('handleClaimContact(message, claimState)');
        const genericIdx = afterNotPending.indexOf('handleGenericContact(message)');
        assert.ok(claimCallIdx !== -1 && genericIdx !== -1);
        assert.ok(claimCallIdx < genericIdx);
    });

    it('attemptSubscribeFromContact is called without a blanket .catch() that could mask a real error as "nothing pending"', () => {
        assert.ok(!/attemptSubscribeFromContact\(message\)\.catch/.test(dispatchBlock));
    });

    it('claim state functions still target only bot_user_states (untouched)', () => {
        const claimStateBlock = content.slice(
            content.indexOf('async function clearClaimState'),
            content.indexOf('async function getClaimState') + 500
        );
        assert.ok(claimStateBlock.includes('bot_user_states'));
        assert.ok(!claimStateBlock.includes('bot_subscription_states'));
    });
});

describe('bot-claim.js — /unsubscribe command', () => {
    it('dispatcher routes /unsubscribe text to handleUnsubscribeCommand before falling through to baseHandler', () => {
        assert.match(content, /text\.startsWith\('\/unsubscribe'\)/);
        assert.match(content, /await handleUnsubscribeCommand\(message, bookingIdText\)/);
    });

    it('handleUnsubscribeCommand calls /claims/bot/unsubscribe with bookingId and telegramUserId', () => {
        const block = content.slice(content.indexOf('async function handleUnsubscribeCommand'));
        assert.ok(block.includes("backendPost('/claims/bot/unsubscribe'"));
        assert.ok(block.includes('bookingId'));
        assert.ok(block.includes('telegramUserId: message.from?.id'));
    });

    it('rejects a missing/non-numeric booking id without calling the backend', () => {
        const block = content.slice(
            content.indexOf('async function handleUnsubscribeCommand'),
            content.indexOf('export default async function handler')
        );
        assert.match(block, /if\s*\(!bookingId\)/);
    });
});

describe('bot-claim.js — handleSubscribeStart clears stale claim state on successful bind', () => {
    const startBlock = content.slice(
        content.indexOf('async function handleSubscribeStart'),
        content.indexOf('async function attemptSubscribeFromContact')
    );

    it('calls clearClaimState(chatId) after a successful bind, so a stale claim_/s_ state left in bot_user_states cannot hijack the upcoming contact-share into the old claim flow', () => {
        assert.match(startBlock, /clearClaimState\(chatId\)/);
    });

    it('the clearClaimState call happens strictly after the bind try/catch resolves successfully — before the "confirm your number" prompt, not before the bind attempt', () => {
        const bindTryIdx = startBlock.indexOf('try {');
        const bindCatchEndIdx = startBlock.indexOf("return;\n  }", startBlock.indexOf('catch (error)'));
        const clearIdx = startBlock.indexOf('clearClaimState(chatId)');
        const confirmPromptIdx = startBlock.indexOf('подтвердите свой номер');
        assert.ok(bindTryIdx !== -1 && bindCatchEndIdx !== -1 && clearIdx !== -1 && confirmPromptIdx !== -1);
        assert.ok(clearIdx > bindCatchEndIdx, 'clearClaimState must run after the bind try/catch, not before or inside it');
        assert.ok(clearIdx < confirmPromptIdx, 'clearClaimState must run before the confirm-number prompt is sent');
    });

    it('a failed/expired bind returns early (inside the catch block) without ever reaching clearClaimState — a stale-but-still-valid claim state must survive a failed subscribe attempt', () => {
        const catchBlock = startBlock.slice(
            startBlock.indexOf('catch (error)'),
            startBlock.indexOf('catch (error)') + 300
        );
        assert.ok(!catchBlock.includes('clearClaimState'));
        assert.match(catchBlock, /return;/);
    });

    it('the clearClaimState call swallows its own errors (never lets a Supabase hiccup break the subscribe flow)', () => {
        assert.match(startBlock, /clearClaimState\(chatId\)\.catch\(\(\)\s*=>\s*\{\}\)/);
    });
});

describe('bot-claim.js — old claim_/s_ flow is functionally unchanged', () => {
    it('claim_/s_ still dispatch to handleClaimStart exactly as before', () => {
        assert.match(content, /parsed\.type === 'claim' \|\| parsed\.type === 's'/);
        assert.match(content, /await handleClaimStart\(message, parsed\.token\)/);
    });

    it('CLAIM_STATE constant value is unchanged', () => {
        assert.match(content, /const CLAIM_STATE = 'waiting_for_ticket_claim_contact';/);
    });
});
