/**
 * phase_subscription_model_bot.test.js
 *
 * POPUTKI.ONLINE — Manual Booking Telegram Subscription Model, bot side.
 *
 * Source-level checks in the same style as phase_e44_bot_claim_cta.test.js /
 * phase_e45_2_bot_claim_messages.test.js (this repo's established
 * convention for auditing api/bot-claim.js), plus direct unit tests of the
 * real parseDeepLink() for the new subscribe_ prefix.
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

describe('bot-claim.js — subscription state isolation from claim state', () => {
    it('SUBSCRIBE_STATE is a distinct constant value from CLAIM_STATE', () => {
        assert.match(content, /const CLAIM_STATE = 'waiting_for_ticket_claim_contact'/);
        assert.match(content, /const SUBSCRIBE_STATE = 'waiting_for_subscription_contact'/);
    });

    it('subscription state reads/writes hit the bot_subscription_states REST path, never bot_user_states', () => {
        const subscriptionStateBlock = content.slice(
            content.indexOf('async function clearSubscriptionState'),
            content.indexOf('async function handleSubscribeStart')
        );
        // Checking the actual REST URL fragments (not a bare word search),
        // since the block's own explanatory comment mentions bot_user_states
        // in prose while comparing risk profiles.
        assert.ok(subscriptionStateBlock.includes('/rest/v1/bot_subscription_states'));
        assert.ok(!subscriptionStateBlock.includes('/rest/v1/bot_user_states'));
    });

    it('claim state functions still target only bot_user_states (untouched)', () => {
        const claimStateBlock = content.slice(
            content.indexOf('async function clearClaimState'),
            content.indexOf('async function getClaimState') + 500
        );
        assert.ok(claimStateBlock.includes('bot_user_states'));
        assert.ok(!claimStateBlock.includes('bot_subscription_states'));
    });

    it('the dispatcher checks claim state and subscription state as two independent lookups, not a shared clear', () => {
        const dispatchBlock = content.slice(content.indexOf('// 2. Process Contact Sharing'));
        assert.match(dispatchBlock, /getClaimState\(message\.chat\.id\)/);
        assert.match(dispatchBlock, /getSubscriptionState\(message\.chat\.id\)/);
    });
});

describe('bot-claim.js — subscribe contact handling mirrors the claim flow\'s anti-spoof guard', () => {
    it('handleSubscribeContact rejects a contact whose user_id differs from the sender', () => {
        const block = content.slice(
            content.indexOf('async function handleSubscribeContact'),
            content.indexOf('async function handleUnsubscribeCommand')
        );
        assert.match(block, /String\(contact\.user_id\)\s*!==\s*String\(sender\.id\)/);
        assert.ok(block.includes('Пересланный контакт не подходит'));
    });

    it('handleSubscribeContact calls /claims/bot/subscribe, never /claims/bot/verify-and-claim', () => {
        const block = content.slice(
            content.indexOf('async function handleSubscribeContact'),
            content.indexOf('async function handleUnsubscribeCommand')
        );
        assert.ok(block.includes("backendPost('/claims/bot/subscribe'"));
        assert.ok(!block.includes('verify-and-claim'));
    });

    it('never logs the raw session token (no console.* call anywhere in bot-claim.js)', () => {
        assert.ok(!/console\.(log|error|warn|info)/.test(content));
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

describe('bot-claim.js — old claim_/s_ flow is functionally unchanged', () => {
    it('claim_/s_ still dispatch to handleClaimStart exactly as before', () => {
        assert.match(content, /parsed\.type === 'claim' \|\| parsed\.type === 's'/);
        assert.match(content, /await handleClaimStart\(message, parsed\.token\)/);
    });

    it('CLAIM_STATE constant value is unchanged', () => {
        assert.match(content, /const CLAIM_STATE = 'waiting_for_ticket_claim_contact';/);
    });
});
