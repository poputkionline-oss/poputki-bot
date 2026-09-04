/**
 * api/acquisitionBotHandler.js
 *
 * Phase P.1G.3: Telegram Bot Acquisition, Web Handshake & Referral Handlers
 */

import { signedBackendPost } from '../utils/signedBackendClient.js';

const TELEGRAM_API = 'https://api.telegram.org';

// The primary /start CTA opens the bus search screen directly (tab=bus is
// the allowlisted deep-link value SearchResultsView.vue already supports),
// instead of the bare Mini App root. Fallback-safe: passed as a Telegram
// WebAppInfo url (an HTTPS Mini App URL), never a plain `url` button field.
const BUS_SEARCH_PATH = '/search?tab=bus';
const START_BUTTON_TEXT = '🚌 Найти билет на автобус';

function getConfig() {
  const miniAppUrl = (process.env.MINI_APP_URL || 'https://poputki.online').replace(/\/$/, '');
  return {
    botToken: process.env.BOT_TOKEN,
    miniAppUrl,
    busSearchUrl: `${miniAppUrl}${BUS_SEARCH_PATH}`
  };
}

async function sendMessage(botToken, payload) {
  const response = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`TELEGRAM_SEND_FAILED_${response.status}`);
  }
  return data;
}

export async function handleWebHandshake(message, rawToken) {
  const { botToken, busSearchUrl } = getConfig();
  const chatId = message.chat.id;
  const sender = message.from;

  try {
    await signedBackendPost('/api/internal/acquisition/consume-telegram-session', {
      raw_token: rawToken,
      telegram_chat_id: chatId,
      telegram_user_id: sender?.id
    });

    const text = [
      '✅ POPUTKI.ONLINE • Официальный бот',
      '',
      'Добро пожаловать!',
      'Ваш аккаунт успешно подключен к сайту.',
      '',
      'Теперь вы можете бронировать поездки, покупать электронные билеты и получать важные уведомления прямо в Telegram.',
      '',
      `Если кнопка ниже не открывается: ${busSearchUrl}`
    ].join('\n');

    await sendMessage(botToken, {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [[
          { text: START_BUTTON_TEXT, web_app: { url: busSearchUrl } }
        ]]
      }
    });
  } catch (error) {
    const text = [
      'Ссылка для подключения уже использована или срок её действия истёк.',
      'Вы можете открыть POPUTKI.ONLINE прямо сейчас кнопкой ниже:',
      '',
      `Если кнопка ниже не открывается: ${busSearchUrl}`
    ].join('\n');

    await sendMessage(botToken, {
      chat_id: chatId,
      text,
      reply_markup: {
        inline_keyboard: [[
          { text: START_BUTTON_TEXT, web_app: { url: busSearchUrl } }
        ]]
      }
    });
  }
}

export async function handleReferralStart(message, code) {
  const { botToken, miniAppUrl } = getConfig();
  const chatId = message.chat.id;
  const sender = message.from;

  signedBackendPost('/api/internal/acquisition/bot-start', {
    telegram_chat_id: chatId,
    user_id: sender?.id,
    source_platform: 'telegram',
    source_medium: 'referral',
    attribution_type: 'passenger_referral'
  }).catch(() => {});

  const text = [
    '👋 Добро пожаловать в POPUTKI.ONLINE по рекомендации друга!',
    '',
    'Быстрый и удобный сервис междугородних поездок и автобусных билетов по Таджикистану.',
    'Нажмите кнопку ниже, чтобы выбрать маршрут и забронировать место.'
  ].join('\n');

  await sendMessage(botToken, {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: '🚗 Найти поездку', web_app: { url: miniAppUrl } }
      ]]
    }
  });
}

export async function handleGenericStart(message) {
  const { botToken, miniAppUrl, busSearchUrl } = getConfig();
  const chatId = message.chat.id;
  const sender = message.from;

  signedBackendPost('/api/internal/acquisition/bot-start', {
    telegram_chat_id: chatId,
    user_id: sender?.id,
    source_platform: 'telegram',
    source_medium: 'messenger',
    attribution_type: 'direct_organic'
  }).catch(() => {});

  const text = [
    '👋 Добро пожаловать в POPUTKI.ONLINE!',
    '',
    'Официальный сервис междугородних поездок и электронных билетов на автобус в Таджикистане.',
    '',
    'Выберите нужное действие:',
    '',
    `Если кнопка ниже не открывается: ${busSearchUrl}`
  ].join('\n');

  await sendMessage(botToken, {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [{ text: START_BUTTON_TEXT, web_app: { url: busSearchUrl } }],
        [{ text: '🎫 Мои билеты', web_app: { url: `${miniAppUrl}/my-bus-tickets` } }]
      ]
    }
  });
}

export async function handleGenericContact(message) {
  const { botToken, busSearchUrl } = getConfig();
  const contact = message.contact;
  const sender = message.from;

  if (contact?.user_id && sender?.id && String(contact.user_id) === String(sender.id)) {
    signedBackendPost('/api/internal/acquisition/contact-shared', {
      telegram_user_id: sender.id,
      telegram_chat_id: message.chat.id
    }).catch(() => {});

    await sendMessage(botToken, {
      chat_id: message.chat.id,
      text: '✅ Ваш номер успешно сохранён в POPUTKI.ONLINE.\n\nТеперь вы можете бронировать поездки и билеты.',
      reply_markup: {
        inline_keyboard: [[
          { text: START_BUTTON_TEXT, web_app: { url: busSearchUrl } }
        ]]
      }
    });
  }
}
