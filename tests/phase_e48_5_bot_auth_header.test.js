/**
 * tests/phase_e48_5_bot_auth_header.test.js
 *
 * PHASE E.48.5.1 — Bot Carpool Service Authorization Header Tests (Decoupled)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Phase E.48.5.1 — Bot Ride Publishing Service Authentication Header (Decoupled)', () => {
    const botSource = readFileSync(resolve('api/bot.js'), 'utf8');

    it('[E48.5.1-B01] bot.js sources service token strictly from BOT_SERVICE_TOKEN', () => {
        assert.ok(botSource.includes('const botServiceToken = process.env.BOT_SERVICE_TOKEN;'));
    });

    it('[E48.5.1-B02] bot.js has NO fallback expression connecting BOT_SERVICE_TOKEN to BOT_TOKEN', () => {
        assert.equal(botSource.includes('process.env.BOT_SERVICE_TOKEN || process.env.BOT_TOKEN'), false);
        assert.equal(botSource.includes('process.env.BOT_SERVICE_TOKEN || process.env.TELEGRAM_BOT_TOKEN'), false);
    });

    it('[E48.5.1-B03] bot.js attaches X-Bot-Service-Token when publishing ride via backend', () => {
        assert.ok(botSource.includes("'X-Bot-Service-Token': botServiceToken"));
    });

    it('[E48.5.1-B04] bot.js does NOT hardcode any service token literal', () => {
        assert.equal(botSource.includes('X-Bot-Service-Token: "'), false);
        assert.equal(botSource.includes("X-Bot-Service-Token: '"), false);
    });

    it('[E48.5.1-B05] Telegram Bot API operations continue using BOT_TOKEN (process.env.BOT_TOKEN)', () => {
        assert.ok(botSource.includes('const BOT_TOKEN = process.env.BOT_TOKEN;'));
        assert.ok(botSource.includes('${TELEGRAM_API}/bot${BOT_TOKEN}/sendMessage'));
    });
});
