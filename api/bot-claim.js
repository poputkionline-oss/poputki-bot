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
    // Phase P.1G.3A: CLAIM_BOT_SHARED_SECRET only — this is a distinct
    // secret from INTERNAL_SERVICE_SECRET (used by signedBackendClient.js
    // for the separate HMAC-signed acquisition-funnel calls) and from
    // BOT_TOKEN. No cross-fallback between them.
    claimSecret: process.env.CLAIM_BOT_SHARED_SECRET,
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

// Written after a successful subscribe bind, in the SAME bot_user_states row
// slot as CLAIM_STATE (setClaimState's own clear-then-insert already
// guarantees at most one row per telegram_id, so writing this state
// naturally clears any stale claim state too — see handleSubscribeStart).
// This is a POSITIVE, persistent (survives across separate serverless
// invocations, unlike an in-process variable) signal that a subscribe bind
// genuinely just succeeded for this telegram id. Its only consumer is the
// dispatcher's decision of what an AMBIGUOUS subscribe-check error should do
// (see handler() below): if this marker is present, the dispatcher must NOT
// fail open toward the claim flow, because doing so risks completing an
// unrelated, older claim session instead of the genuinely-pending
// subscription — exactly the misrouting this whole investigation started
// from. If a later claim_/s_ link is opened, setClaimState's own
// clear-then-insert overwrites this marker, consistent with "most recent
// explicit action wins".
const SUBSCRIBE_PENDING_STATE = 'subscribe_pending_contact';

async function setSubscribePendingMarker(telegramId, expiresAt) {
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
      state: SUBSCRIBE_PENDING_STATE,
      data: { expires_at: expiresAt }
    })
  });

  if (!response.ok) {
    throw new Error(`SUBSCRIBE_PENDING_MARKER_SAVE_FAILED_${response.status}`);
  }
}

async function getSubscribePendingMarker(telegramId) {
  const { supabaseUrl } = getConfig();
  if (!supabaseUrl) return null;

  const response = await fetch(
    `${supabaseUrl}/rest/v1/bot_user_states?telegram_id=eq.${encodeURIComponent(String(telegramId))}&state=eq.${SUBSCRIBE_PENDING_STATE}&select=state,data&limit=1`,
    { headers: supabaseHeaders(false) }
  );

  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!row) return null;

  // A marker past its own TTL is treated as absent — it's only meant to
  // cover the short window between a bind and the immediately-following
  // contact-share, not to fail-closed forever on an old, abandoned bind.
  const expiresAt = row?.data?.expires_at;
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    return null;
  }
  return row;
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

// Manual Booking Telegram Subscription Model: bind-then-complete-by-
// telegram-id. The raw session token from the /start subscribe_<token> deep
// link is presented to the backend exactly once, right here, and then
// discarded — it is a local variable in this function's stack frame, never
// written to bot_user_states, never to any other bot-side table, never
// logged. From this point on the backend addresses the pending subscription
// purely by bound_telegram_id (see fn_bind_booking_subscription_session /
// fn_complete_booking_subscription in the backend migration), so the bot
// itself needs to remember nothing between /start and the contact-share
// reply.
async function handleSubscribeStart(message, rawToken) {
  const { botToken } = getConfig();
  const chatId = message.chat.id;

  if (!/^[a-f0-9]{32}$/i.test(rawToken || '')) {
    await sendMessage(botToken, {
      chat_id: chatId,
      text: 'Ссылка недействительна или повреждена. Откройте страницу билета снова и нажмите «Добавить билет в Telegram».'
    });
    return;
  }

  try {
    const result = await backendPost('/claims/bot/subscribe/bind', {
      sessionToken: rawToken,
      telegramId: chatId
    });
    if (!result.success) {
      throw Object.assign(new Error(result.code || 'BIND_FAILED'), { code: result.code });
    }
  } catch (error) {
    await sendMessage(botToken, {
      chat_id: chatId,
      text: 'Эта ссылка уже недействительна или устарела. Откройте страницу билета заново и снова нажмите «Добавить билет в Telegram».'
    });
    return;
  }

  // Writes SUBSCRIBE_PENDING_STATE in place of any stale claim state (this
  // is defense in depth for the claim-vs-subscribe RACE — not the primary
  // mechanism, which is the dispatcher structurally checking for an active
  // bound subscription session before it ever looks at claim state; see
  // attemptSubscribeFromContact()'s comment). It ALSO leaves a positive,
  // persistent marker the dispatcher can use to tell a genuinely-ambiguous
  // subscribe-check error apart from "nothing to do with subscriptions at
  // all" — see getSubscribePendingMarker()'s own comment. Fine to fail
  // silently: a successful bind is the user's most recent explicit action
  // either way. Only written on a successful bind — a failed/expired token
  // must not destroy a possibly-still-valid claim state.
  const subscribePendingExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // mirrors SUBSCRIPTION_SESSION_TTL_MS backend-side
  await setSubscribePendingMarker(chatId, subscribePendingExpiresAt).catch(() => {});

  await sendMessage(botToken, {
    chat_id: chatId,
    text: [
      '✅ POPUTKI.ONLINE • Официальный бот',
      '',
      'Чтобы добавить билет и получать уведомления о поездке в Telegram, подтвердите свой номер кнопкой ниже.'
    ].join('\n'),
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
}

// In-process only (per warm serverless instance, never persisted): while
// this is in the future, attemptSubscribeFromContact() skips the backend
// round trip entirely and answers 'not_pending' directly. Set only when the
// backend has just told us the subscription feature flag is off
// (FEATURE_DISABLED) — a slow-changing deployment-wide config fact, not a
// per-session outcome — so caching it briefly never hides a genuinely
// pending session (if the flag is ever turned on, that always requires a
// deploy, which cold-starts every instance and clears this anyway; the TTL
// below is just a safety margin for a warm instance that happened to check
// moments before a flag flip). This exists purely to keep the ordinary,
// currently-100%-of-traffic legacy claim flow from depending on a network
// round trip to a feature that is off — it never changes what any answer
// means, only how often the network is asked for it.
let featureDisabledCacheUntilMs = 0;
const FEATURE_DISABLED_CACHE_TTL_MS = 60 * 1000;

// Called from the contact-share dispatcher for every contact share (see
// handler() below), which also decides how to treat this function's outcome
// relative to any legacy claim-flow state in bot_user_states — see the
// dispatcher's own comment for exactly when each outcome does what.
//
// An active bound subscription session must be authoritative over a
// stale/abandoned claim-flow state, and that must hold structurally — never
// merely because handleSubscribeStart happened to clear bot_user_states
// (that clear is defense in depth only; see its own comment). Relying
// solely on clearing stale state is exactly what let a leftover claim state
// hijack a later subscribe contact-share in production.
//
// Returns one of three outcomes — never a plain boolean, so the three cases
// below can never be collapsed into one "fall through" branch by accident:
//   'consumed'    — the subscription flow owns this contact: it either
//                    completed successfully, or a real, reportable failure
//                    (BOOKING_NOT_SUBSCRIBABLE) was shown to the user. The
//                    caller must NOT consult the claim flow.
//   'not_pending' — the backend positively confirmed there is nothing
//                    pending for this telegram id (no bound session, or the
//                    subscription feature flag is off), OR the in-process
//                    FEATURE_DISABLED cache above answered without a
//                    network call at all — only now is it safe to fall
//                    through to the legacy claim-state check.
//   'error'       — an unexpected failure talking to the backend (network
//                    failure, unmapped error code, 5xx). An ambiguous
//                    outcome must never be silently mapped to "nothing
//                    pending" — that is exactly the misrouting this
//                    replaces — so this is deliberately NOT swallowed by a
//                    blanket .catch(() => false)/(() => {}) anywhere. It is
//                    the DISPATCHER's job, not this function's, to decide
//                    whether 'error' should still fail open toward an
//                    already-active claim conversation (see handler()).
async function attemptSubscribeFromContact(message) {
  const { botToken, miniAppUrl } = getConfig();
  const chatId = message.chat.id;
  const contact = message.contact;
  const sender = message.from;

  // Not a self-verified contact share at all (e.g. a forwarded card) — this
  // is never a subscribe attempt, so don't spend a backend round trip on
  // it; let the caller fall through to whatever else applies, exactly as
  // before this model existed.
  if (!contact?.user_id || !sender?.id || String(contact.user_id) !== String(sender.id)) {
    return 'not_pending';
  }

  if (Date.now() < featureDisabledCacheUntilMs) {
    return 'not_pending';
  }

  let result;
  try {
    result = await backendPost('/claims/bot/subscribe', {
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
  } catch (error) {
    // Only these two codes are a POSITIVE confirmation that nothing is
    // pending for this telegram id — no bound session
    // (SESSION_INVALID_EXPIRED_OR_CONSUMED), or the feature flag being off
    // in this environment (FEATURE_DISABLED, the default in production
    // today). Everything else is either a real, reportable failure of an
    // ACTUALLY pending subscription, or a genuinely ambiguous error.
    const notPendingCodes = new Set(['FEATURE_DISABLED', 'SESSION_INVALID_EXPIRED_OR_CONSUMED']);
    if (notPendingCodes.has(error.code)) {
      if (error.code === 'FEATURE_DISABLED') {
        featureDisabledCacheUntilMs = Date.now() + FEATURE_DISABLED_CACHE_TTL_MS;
      }
      return 'not_pending';
    }

    if (error.code === 'BOOKING_NOT_SUBSCRIBABLE') {
      await sendMessage(botToken, {
        chat_id: chatId,
        text: 'Эта поездка больше недоступна для подписки — бронь отменена или поездка уже завершилась.'
      });
      return 'consumed';
    }

    // Unmapped code, or no code at all (network failure, unexpected 5xx):
    // we genuinely do not know whether a subscription session was pending,
    // so this must not be treated as "not pending" — stop here instead of
    // ever reaching the legacy claim flow on an ambiguous outcome.
    await sendMessage(botToken, {
      chat_id: chatId,
      text: 'Не удалось обработать ваш контакт. Попробуйте ещё раз через минуту.'
    });
    return 'error';
  }

  const trip = result.trip || {};
  const summary = [
    '✅ Билет добавлен в Telegram.',
    trip.fromCity ? `🚌 Маршрут: ${trip.fromCity} → ${trip.toCity || '—'}` : null,
    trip.departureDate ? `🗓 Отправление: ${formatDeparture(trip.departureDate, trip.departureTime)}` : null,
    trip.seatNumbers ? `💺 Место: ${formatSeatNumbers(trip.seatNumbers)}` : null,
    '',
    'Вы будете получать уведомления об изменениях этой поездки здесь.'
  ].filter(Boolean).join('\n');

  await sendMessage(botToken, {
    chat_id: chatId,
    text: summary,
    reply_markup: {
      inline_keyboard: [[
        { text: '🎫 Мои поездки', web_app: { url: `${miniAppUrl}/my-bus-tickets` } }
      ]]
    }
  });
  return 'consumed';
}

async function handleUnsubscribeCommand(message, bookingIdText) {
  const { botToken } = getConfig();
  const chatId = message.chat.id;
  const bookingId = parseInt(bookingIdText, 10);

  if (!bookingId) {
    await sendMessage(botToken, {
      chat_id: chatId,
      text: 'Укажите номер брони: /unsubscribe <номер>'
    });
    return;
  }

  try {
    await backendPost('/claims/bot/unsubscribe', {
      bookingId,
      telegramUserId: message.from?.id
    });
    await sendMessage(botToken, {
      chat_id: chatId,
      text: `Вы отписались от уведомлений по брони №${bookingId}.`
    });
  } catch (error) {
    await sendMessage(botToken, {
      chat_id: chatId,
      text: 'Не удалось отписаться. Возможно, вы уже не подписаны на эту бронь.'
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

    if (parsed.type === 'subscribe') {
      await handleSubscribeStart(message, parsed.token);
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

    // parsed.type === 'ride' | 'bus': deliberately not handled here. They
    // are valid:true (see deepLinkParser.js), so control falls through this
    // block to baseHandler(req, res) below, which owns the actual ride/bus
    // deep-link logic (including carrier-ref-token support). Do not add a
    // branch here — that would process the same payload twice.
  }

  // 1b. /unsubscribe <bookingId> — Manual Booking Subscription Model only.
  if (text.startsWith('/unsubscribe')) {
    const bookingIdText = text.trim().split(/\s+/)[1];
    await handleUnsubscribeCommand(message, bookingIdText);
    return res.status(200).json({ ok: true });
  }

  // 2. Process Contact Sharing.
  //
  // The subscription flow is always checked — an active bound subscription
  // session must be authoritative over any old claim-flow state in
  // bot_user_states, and that priority is structural (see
  // attemptSubscribeFromContact()'s own comment), not merely a side effect
  // of handleSubscribeStart clearing bot_user_states on bind.
  //
  // But an ALREADY-ACTIVE, unrelated claim conversation must never be
  // broken by a hiccup checking for a subscription session — that would be
  // a reliability regression against behavior that worked fine before the
  // subscription model existed, and today's production traffic is still
  // 100% legacy claim flow. So claim state is read first, and the two
  // outcomes that matter for it are handled differently:
  //   - subscribeOutcome === 'not_pending': the backend positively
  //     confirmed nothing is pending — safe to run the claim flow (or
  //     generic handling) exactly as before.
  //   - subscribeOutcome === 'error' (an ambiguous/network failure) AND a
  //     claim state exists: fail OPEN toward the claim flow we already know
  //     is genuinely active — UNLESS a persistent SUBSCRIBE_PENDING_STATE
  //     marker shows a subscribe bind genuinely just succeeded for this
  //     telegram id (see setSubscribePendingMarker()'s comment). That marker
  //     means this contact-share is very likely a real, currently-ambiguous
  //     subscription attempt, not stale claim litter — failing open in that
  //     case would risk silently completing the WRONG (older, unrelated)
  //     claim session instead, exactly the misrouting this whole
  //     investigation started from. Without that marker, this narrows to
  //     the rare coincidence of a stale claim state and a subscribe-check
  //     failure with no evidence of a real subscribe attempt — far better
  //     to fail open there than make every ordinary claim contact-share
  //     depend on the subscription backend's availability.
  //   - subscribeOutcome === 'error' with no claim state: nothing to fail
  //     open to; attemptSubscribeFromContact already sent the user a
  //     generic retry message.
  if (message?.contact) {
    const claimState = await getClaimState(message.chat.id).catch(() => null);
    const hasClaimState = claimState?.state === CLAIM_STATE;

    const subscribeOutcome = await attemptSubscribeFromContact(message);

    if (subscribeOutcome === 'consumed') {
      return res.status(200).json({ ok: true });
    }

    if (subscribeOutcome === 'error') {
      if (hasClaimState) {
        const subscribePending = await getSubscribePendingMarker(message.chat.id).catch(() => null);
        if (!subscribePending) {
          await handleClaimContact(message, claimState);
        }
        // A subscribe-pending marker exists: do NOT fail open — this is
        // very likely a real subscription attempt hitting an ambiguous
        // error, not stale claim litter. attemptSubscribeFromContact
        // already sent the user a generic retry message.
      }
      // No claim state to fail open to either way: attemptSubscribeFromContact
      // already sent the user a generic retry message — nothing else to do.
      return res.status(200).json({ ok: true });
    }

    // subscribeOutcome === 'not_pending'
    if (hasClaimState) {
      await handleClaimContact(message, claimState);
      return res.status(200).json({ ok: true });
    }

    // Generic contact sharing outside ticket claim/subscription
    await handleGenericContact(message);
    return res.status(200).json({ ok: true });
  }

  return baseHandler(req, res);
}

// Test-only: resets the in-process FEATURE_DISABLED cache above so test
// files can start each case from a known state instead of leaking cache
// state across tests that share this module instance (ES module imports
// are cached, so the module-level `featureDisabledCacheUntilMs` variable
// persists across test cases within the same test file otherwise). Never
// imported or called from production code paths.
export function __resetSubscribeCheckCacheForTests() {
  featureDisabledCacheUntilMs = 0;
}
