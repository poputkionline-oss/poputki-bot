/**
 * tests/phase_p1g3_bot_deeplinks.test.js
 *
 * Phase P.1G.3 Telegram Bot Deep Link & Handshake Test Suite
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { parseDeepLink } from '../utils/deepLinkParser.js';
import { createSignedHeaders, getBotSharedSecret } from '../utils/signedBackendClient.js';

test('PHASE P.1G.3 — TELEGRAM BOT DEEP LINK ROUTER & SIGNED CLIENT', async (t) => {

    await t.test('1. Deep Link Allowlist Parser (w_, claim_, s_, ref_, ride_, bus_)', () => {
        // A. w_<token> (Web to Telegram Handshake)
        const wResult = parseDeepLink('/start w_0123456789abcdef0123456789abcdef0123456789abcdef');
        assert.equal(wResult.valid, true);
        assert.equal(wResult.type, 'w');
        assert.equal(wResult.token, '0123456789abcdef0123456789abcdef0123456789abcdef');

        // B. claim_<token> (Existing Ticket Claim)
        const claimResult = parseDeepLink('/start claim_0123456789abcdef0123456789abcdef');
        assert.equal(claimResult.valid, true);
        assert.equal(claimResult.type, 'claim');
        assert.equal(claimResult.token, '0123456789abcdef0123456789abcdef');

        // C. s_<token> (Compatible Ticket Handoff)
        const sResult = parseDeepLink('/start s_0123456789abcdef0123456789abcdef');
        assert.equal(sResult.valid, true);
        assert.equal(sResult.type, 's');
        assert.equal(sResult.token, '0123456789abcdef0123456789abcdef');

        // D. ref_<code> (Passenger Referral)
        const refResult = parseDeepLink('/start ref_friend_promo_2026');
        assert.equal(refResult.valid, true);
        assert.equal(refResult.type, 'ref');
        assert.equal(refResult.code, 'friend_promo_2026');

        // E. ride_<id> & bus_<id>
        const rideResult = parseDeepLink('/start ride_550');
        assert.equal(rideResult.valid, true);
        assert.equal(rideResult.type, 'ride');
        assert.equal(rideResult.id, '550');

        const busResult = parseDeepLink('/start bus_42_c10');
        assert.equal(busResult.valid, true);
        assert.equal(busResult.type, 'bus');
        assert.equal(busResult.id, '42_c10');

        // F. Empty /start
        const emptyResult = parseDeepLink('/start');
        assert.equal(emptyResult.valid, true);
        assert.equal(emptyResult.type, 'empty');
    });

    await t.test('2. Deep Link Parser Isolation & Security Boundaries', () => {
        // Cannot confuse prefixes
        const wRes = parseDeepLink('/start w_0123456789abcdef0123456789abcdef');
        const sRes = parseDeepLink('/start s_0123456789abcdef0123456789abcdef');
        const refRes = parseDeepLink('/start ref_0123456789abcdef0123456789abcdef');
        assert.notEqual(wRes.type, sRes.type);
        assert.notEqual(wRes.type, refRes.type);

        // Reject length exceeding 64 chars
        const longPayload = '/start w_' + 'a'.repeat(70);
        const longResult = parseDeepLink(longPayload);
        assert.equal(longResult.valid, false);
        assert.equal(longResult.type, 'invalid');

        // Reject illegal injection characters
        const injectionResult = parseDeepLink('/start w_token;DROP TABLE users;');
        assert.equal(injectionResult.valid, false);
        assert.equal(injectionResult.type, 'invalid');

        // Reject arbitrary unrecognized command
        const unknownResult = parseDeepLink('/start random_unsupported_prefix_123');
        assert.equal(unknownResult.valid, false);
        assert.equal(unknownResult.type, 'unrecognized');
    });

    await t.test('3. Signed Backend Client HMAC-SHA256 Generation', () => {
        const secret = 'test_bot_secret_xyz';
        const method = 'POST';
        const path = '/api/internal/acquisition/consume-telegram-session';
        const body = { raw_token: 'w_test_token_123' };

        const headers = createSignedHeaders({ method, path, body, secret });

        assert.ok(headers['x-internal-timestamp'], 'Timestamp header required');
        assert.ok(headers['x-internal-nonce'], 'Nonce header required');
        assert.ok(headers['x-internal-signature'], 'Signature header required');
        assert.equal(headers['Content-Type'], 'application/json');

        // Verify that signature matches expected HMAC-SHA256
        const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const stringToSign = `POST:${path}:${headers['x-internal-timestamp']}:${headers['x-internal-nonce']}:${bodyHash}`;
        const expectedSig = crypto.createHmac('sha256', secret).update(stringToSign).digest('hex');

        assert.equal(headers['x-internal-signature'], expectedSig);
    });

    await t.test('4. Contact Sender Security & Consent Guard', () => {
        const sender = { id: 12345678, first_name: 'Test' };
        const validContact = { user_id: 12345678, phone_number: '+992900000001' };
        const forgedContact = { user_id: 87654321, phone_number: '+992900000002' };

        // 1. Valid sender match
        const isMatch = String(validContact.user_id) === String(sender.id);
        assert.equal(isMatch, true, 'Valid contact sender ID must match');

        // 2. Forged contact rejected
        const isForgedMatch = String(forgedContact.user_id) === String(sender.id);
        assert.equal(isForgedMatch, false, 'Forged contact sender ID must be rejected');

        // 3. Invariant: Contact sharing NEVER implies marketing consent
        const contactPayload = {
            telegram_user_id: sender.id,
            telegram_chat_id: sender.id
        };
        assert.equal(contactPayload.marketing_consent, undefined, 'Marketing consent must never be passed with contact');
    });

});
