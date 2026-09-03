/**
 * tests/phase_e48_5_bot_auth_header.test.js
 *
 * PHASE E.48.5 — Bot Carpool Service Authorization Header Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Phase E.48.5 — Bot Ride Publishing Service Authentication Header', () => {
    const botSource = readFileSync(resolve('api/bot.js'), 'utf8');

    it('[E48.5-B01] bot.js references BOT_SERVICE_TOKEN or fallback BOT_TOKEN', () => {
        assert.ok(botSource.includes('process.env.BOT_SERVICE_TOKEN || process.env.BOT_TOKEN'));
    });

    it('[E48.5-B02] bot.js attaches X-Bot-Service-Token when publishing ride via backend', () => {
        assert.ok(botSource.includes("'X-Bot-Service-Token': botServiceToken"));
    });

    it('[E48.5-B03] bot.js does NOT hardcode any service token literal', () => {
        assert.equal(botSource.includes('X-Bot-Service-Token: "'), false);
        assert.equal(botSource.includes("X-Bot-Service-Token: '"), false);
    });
});
