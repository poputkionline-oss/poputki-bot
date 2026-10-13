import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGeoCity } from '../utils/geoCityResolver.js';
import { handleGeolocation } from '../utils/geolocationHandler.js';
import handler from '../api/bot-claim.js';
import { pollWebhookSecret } from '../utils/purchasePollHandler.js';

test('Khujand matches Russian and Tajik aliases in service dictionary', () => {
  assert.equal(resolveGeoCity(40.28256, 69.62216, ['Худжанд', 'Душанбе']), 'Худжанд');
  assert.equal(resolveGeoCity(40.28256, 69.62216, ['Хуҷанд']), 'Хуҷанд');
});

test('Bot lookup links only the resolved city, never exact coordinates', async () => {
  let sent;
  await handleGeolocation({ chat: { id: 1 }, location: { latitude: 40.28256, longitude: 69.62216 } }, {
    backendApiUrl: 'https://example.com/api', miniAppUrl: 'https://www.poputki.online',
    fetchImpl: async () => ({ ok: true, json: async () => ['Худжанд'] }),
    sendMessage: async payload => { sent = payload; }
  });
  const url = new URL(sent.reply_markup.inline_keyboard[0][0].web_app.url);
  assert.equal(url.searchParams.get('from'), 'Худжанд');
  assert.equal(url.searchParams.get('tab'), 'bus');
  assert.doesNotMatch(JSON.stringify(sent), /40\.28256|69\.62216/);
});
test('Bot city service failure still offers manual search', async () => {
  let sent;
  await handleGeolocation({ chat: { id: 1 }, location: { latitude: 40, longitude: 69 } }, {
    backendApiUrl: 'https://example.com/api', miniAppUrl: 'https://www.poputki.online',
    fetchImpl: async () => { throw new Error('offline'); }, sendMessage: async payload => { sent = payload; }
  });
  assert.match(sent.text, /вручную/);
  assert.equal(new URL(sent.reply_markup.inline_keyboard[0][0].web_app.url).searchParams.has('from'), false);
});
test('Real webhook dispatcher handles location without logging or reaching legacy AI', async () => {
  const oldFetch = global.fetch;
  const oldLog = console.log;
  const oldToken = process.env.BOT_TOKEN;
  process.env.BOT_TOKEN = 'test-location-token';
  const calls = [], logs = [];
  global.fetch = async (url, options) => {
    calls.push(String(url));
    if (String(url).includes('/general/cities')) return { ok: true, json: async () => ['Худжанд'] };
    assert.match(String(url), /sendMessage$/);
    const payload = JSON.parse(options.body);
    assert.match(payload.text, /Худжанд/);
    return { ok: true, json: async () => ({ ok: true }) };
  };
  console.log = (...args) => logs.push(args);
  const makeRes = () => ({ code: 0, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  try {
    const body = { update_id: 1, message: { chat: { id: 1, type: 'private' }, from: { id: 1 }, location: { latitude: 40.28256, longitude: 69.62216 } } };
    const rejected = makeRes();
    await handler({ method: 'POST', body, headers: {} }, rejected);
    assert.equal(rejected.code, 401);
    assert.equal(calls.length, 0);
    const accepted = makeRes();
    await handler({ method: 'POST', body, headers: { 'x-telegram-bot-api-secret-token': pollWebhookSecret(process.env.BOT_TOKEN) } }, accepted);
    assert.equal(accepted.code, 200);
    assert.equal(calls.length, 2);
    assert.equal(logs.length, 0);
  } finally {
    global.fetch = oldFetch; console.log = oldLog;
    if (oldToken === undefined) delete process.env.BOT_TOKEN; else process.env.BOT_TOKEN = oldToken;
  }
});
test('Dushanbe and international city matching', () => {
  assert.equal(resolveGeoCity(38.53575, 68.77905, ['Душанбе']), 'Душанбе');
  assert.equal(resolveGeoCity(41.26465, 69.21627, ['Ташкент']), 'Ташкент');
  assert.equal(resolveGeoCity(61.25, 73.41667, ['Сургут']), 'Сургут');
});
test('No wrong distant departure or unsupported city', () => {
  assert.equal(resolveGeoCity(40.28256, 69.62216, ['Душанбе']), null);
  assert.equal(resolveGeoCity(0, 0, ['Худжанд']), null);
  assert.equal(resolveGeoCity(40.28256, 69.62216, []), null);
});
test('Malformed and imprecise coordinates are rejected', () => {
  for (const [lat, lon, accuracy] of [[null, 69], ['40', 69], [NaN, 69], [91, 0], [0, 181], [40.28256,69.62216,10001]])
    assert.equal(resolveGeoCity(lat, lon, ['Худжанд'], accuracy), null);
});

test('Live service names retain country suffixes and enforce their countries', () => {
  assert.equal(resolveGeoCity(40.28256, 69.62216, ['Худжанд (TJ)', 'Душанбе (TJ)']), 'Худжанд (TJ)');
  assert.equal(resolveGeoCity(61.25, 73.41667, ['Сургут (РФ)']), 'Сургут (РФ)');
  assert.equal(resolveGeoCity(40.28256, 69.62216, ['Худжанд (UZ)']), null);
});
