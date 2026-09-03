import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('PHASE E.44 — BOT CLAIM CTA AUDIT & INLINE BUTTON TESTS', () => {
    const botClaimPath = path.resolve(__dirname, '../api/bot-claim.js');
    const content = fs.readFileSync(botClaimPath, 'utf8');

    it('1. getConfig includes miniAppUrl with fallback to https://poputki.online', () => {
        assert.ok(content.includes('miniAppUrl: (process.env.MINI_APP_URL || \'https://poputki.online\').replace(/\\/$/, \'\')'));
    });

    it('2. handleClaimContact extracts miniAppUrl from getConfig()', () => {
        assert.ok(content.includes('const { botToken, miniAppUrl } = getConfig();'));
    });

    it('3. Pending verification message includes [ 🎫 Мои поездки ] inline button targeting /my-bus-tickets', () => {
        // Phase E.45.2: default pending text now lives in the pendingText ternary
        assert.ok(content.includes('✅ Номер получен. Запрос на подтверждение билета передан диспетчеру рейса. Билет остаётся действительным для посадки.'));
        assert.ok(content.includes('text: pendingText,'));
        assert.ok(content.includes('{ text: \'🎫 Мои поездки\', web_app: { url: `${miniAppUrl}/my-bus-tickets` } }'));
    });

    it('4. Claimed confirmation message includes [ 🎫 Мои поездки ] inline button targeting /my-bus-tickets', () => {
        // Phase E.45.2: updated success copy
        assert.ok(content.includes('text: \'✅ Номер подтверждён.\\n\\nБилет успешно добавлен в ваши поездки.\''));
        assert.ok(content.includes('{ text: \'🎫 Мои поездки\', web_app: { url: `${miniAppUrl}/my-bus-tickets` } }'));
    });

    it('5. Button is a read-only Telegram Web App launcher: no booking creation, no ownership transfer', () => {
        // The inline keyboard uses web_app, not a callback_query that executes server-side claim mutation
        const inlineKeyboards = content.match(/inline_keyboard:\s*\[\[[\s\S]*?\]\]/g) || [];
        assert.strictEqual(inlineKeyboards.length, 2);
        for (const ik of inlineKeyboards) {
            assert.ok(ik.includes('web_app: { url: `${miniAppUrl}/my-bus-tickets` }'));
            assert.ok(!ik.includes('callback_data:')); // No automatic backend mutation callback
        }
    });

    it('6. Pending verification state is NOT bypassed by button', () => {
        // Notice result.status !== 'claimed' falls through to pending message without calling executeAtomicClaim
        assert.ok(content.includes("if (result.status === 'claimed')"));
        assert.ok(!content.includes("result.status = 'claimed'")); // No mutation of result status
    });
});
