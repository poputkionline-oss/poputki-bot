import crypto from 'crypto';
import { signedBackendPost } from './signedBackendClient.js';
export function pollWebhookSecret(token) { return crypto.createHash('sha256').update('poputki-polls-webhook-v1:' + token).digest('hex'); }
export async function handlePurchasePoll(req, { post = signedBackendPost, send = null } = {}) {
    const update = req.body || {};
    const vote = update.poll_answer;
    const message = update.message;
    const privateText = message?.chat?.type === 'private' && String(message.from?.id) === String(message.chat.id) && typeof message.text === 'string'
        && (!message.text.startsWith('/') || message.text === '/cancel');
    if (!vote && !privateText) return false;
    const token = process.env.BOT_TOKEN;
    const header = req.headers?.['x-telegram-bot-api-secret-token'];
    // Legacy generic text can still use the base handler, which no longer writes polls.
    if (!vote && !header) return false;
    const expected = token ? pollWebhookSecret(token) : '';
    if (!expected || typeof header !== 'string' || header.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected))) {
        const err = new Error('UNTRUSTED_POLL_WEBHOOK'); err.status = 401; throw err;
    }
    let payload, chatId;
    if (vote) {
        chatId = vote.user?.id;
        if (!Number.isSafeInteger(chatId) || chatId < 1 || !Array.isArray(vote.option_ids) || vote.option_ids.length !== 1) return true;
        const option = vote.option_ids[0];
        if (!Number.isInteger(option) || option < 0 || option > 3 || typeof vote.poll_id !== 'string') return true;
        payload = { action: 'vote', telegram_id: String(chatId), poll_id: vote.poll_id, option };
    } else {
        chatId = message.from.id;
        payload = { action: 'text', telegram_id: String(chatId), text: message.text };
    }
    const result = await post('/api/internal/polls/answer', payload);
    if (!vote && result.status === 'ignored') return false;
    const texts = {
        saved: 'Спасибо! Ваш ответ сохранён и поможет нам улучшить сервис.',
        custom: 'Напишите, что помешало завершить покупку билета (до 2000 символов). Для отмены — /cancel.',
        cancelled: 'Ввод ответа отменён.',
        expired: 'Время для ввода ответа истекло.',
        invalid: 'Напишите ответ длиной от 1 до 2000 символов или /cancel.',
        legacy: 'Этот старый опрос завершён. Спасибо за Ваш интерес.'
    };
    if (texts[result.status]) {
        if (send) await send(chatId, texts[result.status]);
        else {
            const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: texts[result.status] }) });
            const body = await response.json();
            if (!response.ok || !body?.ok) throw new Error('POLL_REPLY_FAILED');
        }
    }
    return true;
}
