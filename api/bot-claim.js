import baseHandler from './bot.js';
import { parseDeepLink } from '../utils/deepLinkParser.js';
import { signedBackendPost } from '../utils/signedBackendClient.js';
import {
  handleWebHandshake,
  handleReferralStart,
  handleGenericStart,
  handleGenericContact
} from './acquisitionBotHandler.js';

const TELEGRAM_API = 'https://api.telegram.org';
const CLAIM_STATE = 'waiting_for_ticket_claim_contact';

function getConfig() {
  return {
    botToken: process.env.BOT_TOKEN,
    backendApiUrl: (process.env.BACKEND_API_URL || 'https://poputki-backend-9dv6.onrender.com/api').replace(/\/$/, ''),
    claimSecret: process.env.CLAIM_BOT_SHARED_SECRET || process.env.INTERNAL_SERVICE_SECRET || process.env.BOT_TOKEN,
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
    miniAppUrl: (process.env.MINI_APP_URL || 'https://poputki.online').replace(/\/$/, '')
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

async function backendPost(path, body) {
  const { backendApiUrl, claimSecret } = getConfig();
  if (!claimSecret) {
    const error = new Error('CLAIM_BOT_NOT_CONFIGURED');
    error.code = 'CLAIM_BOT_NOT_CONFIGURED';
    throw error;
  }

  const response = await fetch(`${backendApiUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Claim-Bot-Secret': claimSecret
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.code || data.error || `BACKEND_${response.status}`);
    error.code = data.code || data.error || `BACKEND_${response.status}`;
    throw error;
  }
  return data;
}

function supabaseHeaders(contentType = false) {
  const { supabaseAnonKey } = getConfig();
  const headers = {
    apikey: supabaseAnonKey,
    Authorization: `Bearer ${supabaseAnonKey}`
  };
  if (contentType) headers['Content-Type'] = 'application/json';
  return headers;
}

async function clearClaimState(telegramId) {
  const { supabaseUrl } = getConfig();
  if (!supabaseUrl) return;
  await fetch(`${supabaseUrl}/rest/v1/bot_user_states?telegram_id=eq.${encodeURIComponent(String(telegramId))}`, {
    method: 'DELETE',
    headers: supabaseHeaders(false)
  });
}

async function setClaimState(telegramId, sessionId, expiresAt) {
  const { supabaseUrl } = getConfig();
  if (!supabaseUrl) throw new Error('SUPABASE_NOT_CONFIGURED');

  await clearClaimState(telegramId);

  const response = await fetch(`${supabaseUrl}/rest/v1/bot_user_states`, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(true),
      Prefer: 'return=minimal'
    },
    body: JSON.stringify({
      telegram_id: String(telegramId),
      state: CLAIM_STATE,
      data: {
        session_id: sessionId,
        expires_at: expiresAt
      }
    })
  });

  if (!response.ok) {
    throw new Error(`CLAIM_STATE_SAVE_FAILED_${response.status}`);
  }
}

async function getClaimState(telegramId) {
  const { supabaseUrl } = getConfig();
  if (!supabaseUrl) return null;

  const response = await fetch(
    `${supabaseUrl}/rest/v1/bot_user_states?telegram_id=eq.${encodeURIComponent(String(telegramId))}&state=eq.${CLAIM_STATE}&select=state,data&limit=1`,
    { headers: supabaseHeaders(false) }
  );

  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

function formatSeatNumbers(seatNumbers) {
  let seats = seatNumbers;
  if (typeof seats === 'string') {
    try { seats = JSON.parse(seats); } catch (_) { seats = [seats]; }
  }
  if (!Array.isArray(seats)) seats = seats == null ? [] : [seats];
  return seats.length ? seats.join(', ') : '—';
}

function formatDeparture(date, time) {
  const safeDate = date || '—';
  const safeTime = time ? String(time).slice(0, 5) : '—';
  return `${safeDate} ${safeTime}`;
}

async function handleClaimStart(message, rawToken) {
  const { botToken } = getConfig();
  const chatId = message.chat.id;

  if (!/^[a-f0-9]{32,64}$/i.test(rawToken || '')) {
    await sendMessage(botToken, {
      chat_id: chatId,
      text: 'Ссылка на билет недействительна или повреждена. Откройте Telegram снова из электронного билета.'
    });
    return;
  }

  try {
    const opened = await backendPost('/claims/bot/open', { sessionToken: rawToken });
    await setClaimState(chatId, opened.sessionId, opened.expiresAt);

    const trip = opened.trip || {};
    const summary = [
      '✅ POPUTKI.ONLINE • Официальный бот',
      '',
      'Ваш билет найден.',
      `🚌 Маршрут: ${trip.fromCity || '—'} → ${trip.toCity || '—'}`,
      `🗓 Отправление: ${formatDeparture(trip.departureDate, trip.departureTime)}`,
      `💺 Место: ${formatSeatNumbers(trip.seatNumbers)}`,
      trip.carrierName ? `🏢 Перевозчик: ${trip.carrierName}` : null,
      '',
      'Чтобы получать уведомления о поездке прямо в Telegram, подтвердите свой номер кнопкой ниже.',
      'Билет действителен для посадки и без подключения Telegram.'
    ].filter(Boolean).join('\n');

    await sendMessage(botToken, {
      chat_id: chatId,
      text: summary,
      reply_markup: {
        keyboard: [[{
          text: '📱 Подтвердить мой номер',
          request_contact: true
        }]],
        resize_keyboard: true,
        one_time_keyboard: true,
        input_field_placeholder: 'Нажмите кнопку для подтверждения номера'
      }
    });
  } catch (error) {
    await clearClaimState(chatId).catch(() => {});
    const expiredCodes = new Set(['SESSION_EXPIRED', 'SESSION_ALREADY_CONSUMED', 'SESSION_NOT_FOUND', 'ALREADY_CLAIMED']);
    const text = expiredCodes.has(error.code)
      ? 'Эта ссылка уже недействительна или была использована. Откройте билет заново и нажмите «Открыть билет в Telegram».'
      : 'Сейчас не удалось открыть билет в Telegram. Сам билет остаётся действительным для посадки. Попробуйте ещё раз позже.';

    await sendMessage(botToken, { chat_id: chatId, text });
  }
}

async function handleClaimContact(message, state) {
  const { botToken, miniAppUrl } = getConfig();
  const chatId = message.chat.id;
  const contact = message.contact;
  const sender = message.from;
  const sessionId = state?.data?.session_id;

  if (!contact?.user_id || !sender?.id || String(contact.user_id) !== String(sender.id)) {
    await sendMessage(botToken, {
      chat_id: chatId,
      text: 'Для безопасности нужно отправить именно свой номер через кнопку «Подтвердить мой номер». Пересланный контакт не подходит.'
    });
    return;
  }

  if (!sessionId) {
    await clearClaimState(chatId).catch(() => {});
    await sendMessage(botToken, {
      chat_id: chatId,
      text: 'Сессия подтверждения устарела. Откройте электронный билет заново и нажмите «Открыть билет в Telegram».',
      reply_markup: { remove_keyboard: true }
    });
    return;
  }

  try {
    const result = await backendPost('/claims/bot/verify-and-claim', {
      sessionId,
      telegramUser: {
        id: sender.id,
        first_name: sender.first_name || null,
        last_name: sender.last_name || null,
        username: sender.username || null
      },
      telegramContact: {
        user_id: contact.user_id,
        phone_number: contact.phone_number
      }
    });

    await clearClaimState(chatId).catch(() => {});

    // Notify acquisition funnel of verified contact sharing (zero consent granted)
    signedBackendPost('/api/internal/acquisition/contact-shared', {
      telegram_user_id: sender.id,
      telegram_chat_id: chatId
    }).catch(() => {});

    if (result.status === 'claimed') {
      await sendMessage(botToken, {
        chat_id: chatId,
        text: '✅ Номер подтверждён.\n\nБилет успешно добавлен в ваши поездки.',
        reply_markup: {
          inline_keyboard: [[
            { text: '🎫 Мои поездки', web_app: { url: `${miniAppUrl}/my-bus-tickets` } }
          ]]
        }
      });
      return;
    }

    const pendingText = result.reason === 'PHONE_MISMATCH_REQUIRES_APPROVAL'
      ? '⚠️ Отправленный номер не совпадает с номером в билете. Запрос на подтверждение передан диспетчеру рейса для проверки. Билет остаётся действительным для посадки.'
      : '✅ Номер получен. Запрос на подтверждение билета передан диспетчеру рейса. Билет остаётся действительным для посадки.';

    await sendMessage(botToken, {
      chat_id: chatId,
      text: pendingText,
      reply_markup: {
        inline_keyboard: [[
          { text: '🎫 Мои поездки', web_app: { url: `${miniAppUrl}/my-bus-tickets` } }
        ]]
      }
    });
  } catch (error) {
    const terminalCodes = new Set([
      'SESSION_EXPIRED',
      'SESSION_ALREADY_CONSUMED',
      'SESSION_NOT_FOUND',
      'BOOKING_NOT_CONFIRMED',
      'ALREADY_CLAIMED'
    ]);

    if (terminalCodes.has(error.code)) {
      await clearClaimState(chatId).catch(() => {});
    }

    let text = 'Не удалось подтвердить билет. Попробуйте ещё раз через электронный билет.';
    if (error.code === 'PHONE_ALREADY_LINKED_TO_ANOTHER_TELEGRAM') {
      text = 'Этот номер уже связан с другим Telegram-аккаунтом в POPUTKI.ONLINE. Для безопасности автоматическое подключение остановлено — обратитесь к диспетчеру.';
    } else if (error.code === 'SESSION_EXPIRED') {
      text = 'Время подтверждения истекло. Откройте электронный билет заново и снова нажмите «Открыть билет в Telegram».';
    }

    await sendMessage(botToken, {
      chat_id: chatId,
      text,
      reply_markup: terminalCodes.has(error.code) ? { remove_keyboard: true } : undefined
    });
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return baseHandler(req, res);
  }

  const message = req.body?.message;
  const isPrivate = message?.chat?.type === 'private';

  if (!isPrivate) {
    return baseHandler(req, res);
  }

  const text = message?.text || '';

  // 1. Process /start commands with allowlist deep link parser
  if (text.startsWith('/start')) {
    const parsed = parseDeepLink(text);

    if (parsed.type === 'w') {
      await handleWebHandshake(message, parsed.token);
      return res.status(200).json({ ok: true });
    }

    if (parsed.type === 'claim' || parsed.type === 's') {
      await handleClaimStart(message, parsed.token);
      return res.status(200).json({ ok: true });
    }

    if (parsed.type === 'ref') {
      await handleReferralStart(message, parsed.code);
      return res.status(200).json({ ok: true });
    }

    if (parsed.type === 'empty' || !parsed.valid) {
      await handleGenericStart(message);
      return res.status(200).json({ ok: true });
    }
  }

  // 2. Process Contact Sharing
  if (message?.contact) {
    const state = await getClaimState(message.chat.id).catch(() => null);
    if (state?.state === CLAIM_STATE) {
      await handleClaimContact(message, state);
      return res.status(200).json({ ok: true });
    }

    // Generic contact sharing outside ticket claim
    await handleGenericContact(message);
    return res.status(200).json({ ok: true });
  }

  return baseHandler(req, res);
}
