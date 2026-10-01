import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePurchasePoll, pollWebhookSecret } from '../utils/purchasePollHandler.js';
process.env.BOT_TOKEN = 'test-poll-token';
const headers = { 'x-telegram-bot-api-secret-token': pollWebhookSecret(process.env.BOT_TOKEN) };
const vote = (id = 55, option = 1) => ({ headers, body: { poll_answer: { poll_id: 'test-poll', user: { id }, option_ids: [option] } } });
test('forged webhook is rejected before signed backend call', async () => {
    let called = false;
    await assert.rejects(handlePurchasePoll({ ...vote(), headers: {} }, { post: async () => { called = true; } }));
    assert.equal(called, false);
});
test('vote identity comes from Telegram voter, never original recipient', async () => {
    let payload, reply;
    await handlePurchasePoll(vote(77), { post: async (path, data) => { payload = { path, data }; return { status: 'saved' }; }, send: async (id, text) => { reply = { id, text }; } });
    assert.equal(payload.data.telegram_id, '77'); assert.equal(payload.path, '/api/internal/polls/answer'); assert.equal(reply.id, 77);
    assert.match(reply.text, /сохранён/);
});
test('persistence failure never thanks or acknowledges saved answer', async () => {
    let sent = false;
    await assert.rejects(handlePurchasePoll(vote(), { post: async () => { throw new Error('DB_FAILURE'); }, send: async () => { sent = true; } }));
    assert.equal(sent, false);
});
test('duplicate and foreign votes are silent; custom vote requests bounded text', async () => {
    for (const status of ['duplicate', 'ignored']) {
        let count = 0; assert.equal(await handlePurchasePoll(vote(), { post: async () => ({ status }), send: async () => count++ }), true); assert.equal(count, 0);
    }
    let text = ''; await handlePurchasePoll(vote(55, 3), { post: async () => ({ status: 'custom' }), send: async (_, value) => { text = value; } }); assert.match(text, /2000/); assert.match(text, /cancel/);
});
test('only authenticated private sender text can enter custom poll flow', async () => {
    const req = { headers, body: { message: { from: { id: 55 }, chat: { id: 55, type: 'private' }, text: 'My reason' } } };
    let payload;
    assert.equal(await handlePurchasePoll(req, { post: async (_, data) => { payload = data; return { status: 'ignored' }; } }), false); assert.equal(payload.text, 'My reason');
    req.body.message.chat.id = 99; payload = null;
    assert.equal(await handlePurchasePoll(req, { post: async (_, data) => { payload = data; } }), false); assert.equal(payload, null);
});
test('withdrawals, multiple or invalid choices never reach backend', async () => {
    for (const options of [[], [0, 1], [4], [-1]]) {
        const req = vote(); req.body.poll_answer.option_ids = options;
        let called = false; assert.equal(await handlePurchasePoll(req, { post: async () => { called = true; } }), true); assert.equal(called, false);
    }
});
