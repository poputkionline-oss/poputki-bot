/**
 * utils/assistantChatClient.js
 *
 * Client module for calling the internal assistant-chat Edge Function.
 * Designed with fail-closed architecture: if disabled, unconfigured,
 * timed out, or rate-limited, safely returns fallback: true so the bot
 * delivers the existing static menu.
 *
 * Requirements:
 * - Feature flag AI_ASSISTANT_ENABLED (default false)
 * - Pilot whitelist support (AI_PILOT_WHITELIST)
 * - Strict timeout via AbortController (default 15000ms)
 * - Idempotency request_id derived from Telegram update_id
 * - Zero secrets or PII leakage in logs
 */

export function getConfig() {
  const rawPublic = (process.env.AI_ASSISTANT_PUBLIC_ENABLED || '').trim().toLowerCase();
  return {
    enabled: process.env.AI_ASSISTANT_ENABLED === 'true',
    publicEnabled: rawPublic === 'true',
    endpoint: process.env.AI_ASSISTANT_ENDPOINT || (process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL.replace(/\/$/, '')}/functions/v1/assistant-chat` : ''),
    sharedSecret: process.env.INTERNAL_BOT_ASSISTANT_SECRET || null,
    timeoutMs: Number(process.env.AI_REQUEST_TIMEOUT_MS) || 15000,
    whitelist: (process.env.AI_PILOT_WHITELIST || '')
      .split(',')
      .map(id => id.trim())
      .filter(Boolean)
  };
}

/**
 * Calls internal assistant-chat Edge Function.
 *
 * @param {Object} params
 * @param {number|string} params.updateId Telegram update_id
 * @param {number|string} params.telegramId Telegram user ID (from.id)
 * @param {number|string} params.chatId Telegram chat ID (chat.id)
 * @param {string} params.message Raw user text
 * @returns {Promise<{ ok: boolean, reply?: string, trips?: Array<any>, fallback: boolean, reason?: string }>}
 */
export async function callAssistantChat({ updateId, telegramId, chatId, message }) {
  const config = getConfig();

  // 1. Kill-switch check (AI_ASSISTANT_ENABLED takes absolute precedence)
  if (!config.enabled) {
    return { ok: false, fallback: true, reason: 'AI_DISABLED' };
  }

  // 2. Secret & Endpoint check
  if (!config.endpoint || !config.sharedSecret) {
    return { ok: false, fallback: true, reason: 'SERVICE_UNCONFIGURED' };
  }

  // 3. Telegram ID validation
  const userTidStr = String(telegramId ?? '').trim();
  const userTidNum = Number(userTidStr);
  const isValidTelegramId = /^\d+$/.test(userTidStr) && Number.isFinite(userTidNum) && userTidNum > 0;
  if (!isValidTelegramId) {
    return { ok: false, fallback: true, reason: 'INVALID_TELEGRAM_ID' };
  }

  // 4. Access admission: Pilot Whitelist OR Public Access Mode
  const isWhitelisted = config.whitelist.includes(userTidStr);
  if (!isWhitelisted && !config.publicEnabled) {
    return { ok: false, fallback: true, reason: 'NOT_IN_WHITELIST' };
  }

  // 5. Message length & sanitization check
  const text = (message || '').trim();
  if (!text || text.length > 1000) {
    return { ok: false, fallback: true, reason: 'INVALID_LENGTH' };
  }

  // 5. Idempotent Request ID
  const requestId = `tg_upd_${String(updateId).replace(/[^a-zA-Z0-9_\-]/g, '')}`;

  // 6. Bounded fetch call with AbortController
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bot-Service-Secret': config.sharedSecret
      },
      body: JSON.stringify({
        telegram_id: Number(telegramId),
        chat_id: Number(chatId),
        message: text,
        request_id: requestId
      }),
      signal: controller.signal
    });

    // Safely parse response JSON body once
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      if (response.status === 429) {
        if (data?.error === 'RATE_LIMITED_DAILY') {
          return { ok: false, fallback: true, reason: 'RATE_LIMITED_DAILY' };
        }
        if (data?.error === 'RATE_LIMITED_GLOBAL_STOP_LOSS' || data?.error === 'RATE_LIMITED_GLOBAL') {
          return { ok: false, fallback: true, reason: 'RATE_LIMITED_GLOBAL' };
        }
      }
      return { ok: false, fallback: true, reason: `HTTP_${response.status}` };
    }

    if (!data?.ok || !data?.reply) {
      return { ok: false, fallback: true, reason: data?.error || 'INVALID_RESPONSE' };
    }

    return {
      ok: true,
      reply: data.reply,
      trips: Array.isArray(data.trips) ? data.trips : [],
      fallback: false
    };
  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    return {
      ok: false,
      fallback: true,
      reason: isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR'
    };
  } finally {
    clearTimeout(timer);
  }
}
