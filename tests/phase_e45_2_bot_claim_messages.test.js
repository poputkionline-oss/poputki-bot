import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * PHASE E.45.2 — Bot claim messages: updated success copy + distinct
 * PHONE_MISMATCH explanation.
 *
 * Backend (routes/claims.js /claims/bot/verify-and-claim) already returns
 * `reason: evaluation.reason` on the non-claimed branch, carrying
 * PHONE_MISMATCH_REQUIRES_APPROVAL when a fresh Telegram contact-share phone
 * doesn't match the booking's stored phone. The bot previously collapsed
 * every non-claimed outcome into one generic "передан диспетчеру" message;
 * it must now give phone-mismatch users a clear, safe explanation instead.
 */
describe('PHASE E.45.2 — Bot claim success/pending message updates', () => {
    const botClaimPath = path.resolve(__dirname, '../api/bot-claim.js');
    const content = fs.readFileSync(botClaimPath, 'utf8');

    it('1. Success message matches the required copy exactly', () => {
        assert.ok(content.includes("text: '✅ Номер подтверждён.\\n\\nБилет успешно добавлен в ваши поездки.'"));
    });

    it('2. Success branch still gated strictly on status === \'claimed\'', () => {
        assert.ok(content.includes("if (result.status === 'claimed')"));
    });

    it('3. Pending branch derives pendingText from result.reason', () => {
        assert.ok(content.includes("const pendingText = result.reason === 'PHONE_MISMATCH_REQUIRES_APPROVAL'"));
        assert.ok(content.includes('text: pendingText,'));
    });

    it('4. PHONE_MISMATCH branch gives a distinct, safe explanation (not the generic dispatcher message)', () => {
        const phoneMismatchText = '⚠️ Отправленный номер не совпадает с номером в билете. Запрос на подтверждение передан диспетчеру рейса для проверки. Билет остаётся действительным для посадки.';
        assert.ok(content.includes(phoneMismatchText));
        // Must not leak any raw phone number, booking id, or other PII into the copy itself.
        assert.ok(!/\+?\d{7,}/.test(phoneMismatchText));
    });

    it('5. Default (non-phone-mismatch) pending outcomes keep the original safe generic copy', () => {
        assert.ok(content.includes(': \'✅ Номер получен. Запрос на подтверждение билета передан диспетчеру рейса. Билет остаётся действительным для посадки.\''));
    });

    it('6. Both success and pending messages still carry the [ 🎫 Мои поездки ] button', () => {
        const inlineKeyboards = content.match(/inline_keyboard:\s*\[\[[\s\S]*?\]\]/g) || [];
        assert.strictEqual(inlineKeyboards.length, 2, 'exactly the claimed + pending inline keyboards');
        for (const ik of inlineKeyboards) {
            assert.ok(ik.includes('{ text: \'🎫 Мои поездки\', web_app: { url: `${miniAppUrl}/my-bus-tickets` } }'));
        }
    });

    it('7. No message text includes a raw session id, phone number, or claim token', () => {
        // Every literal chat message string in the file must stay free of template
        // interpolation of raw identifiers/PII — a structural regression guard.
        const textLiterals = [...content.matchAll(/text:\s*'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]);
        for (const text of textLiterals) {
            assert.ok(!text.includes('${'), `message text must not interpolate raw values: ${text}`);
        }
    });
});
