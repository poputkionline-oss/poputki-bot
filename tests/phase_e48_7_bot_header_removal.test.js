/**
 * tests/phase_e48_7_bot_header_removal.test.js
 *
 * PHASE E.48.7 — Bot Legacy Header Removal Verification Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Phase E.48.7 — Bot Legacy Header Removal', () => {
    const botSource = readFileSync(resolve('api/bot.js'), 'utf-8');

    it('[E48.7-B01] bot.js does NOT send x-mana-man header to backend /rides', () => {
        assert.equal(botSource.includes('x-mana-man'), false);
        assert.equal(botSource.includes('nasa.2006'), false);
    });

    it('[E48.7-B02] bot.js preserves X-Bot-Service-Token sender strictly from BOT_SERVICE_TOKEN', () => {
        assert.ok(botSource.includes('const botServiceToken = process.env.BOT_SERVICE_TOKEN;'));
        assert.ok(botSource.includes("'X-Bot-Service-Token': botServiceToken"));
    });

    it('[E48.7-B03] BOT_TOKEN remains strictly isolated to Telegram API calls', () => {
        assert.ok(botSource.includes('const BOT_TOKEN = process.env.BOT_TOKEN;'));
        assert.equal(botSource.includes("'X-Bot-Service-Token': BOT_TOKEN"), false);
        assert.equal(botSource.includes("'X-Bot-Service-Token': process.env.BOT_TOKEN"), false);
    });
});
