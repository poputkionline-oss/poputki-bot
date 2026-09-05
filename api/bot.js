import { callAssistantChat } from '../utils/assistantChatClient.js';

const TELEGRAM_API = "https://api.telegram.org";
const syncedGroups = new Set();

export default async function handler(req, res) {
  // Use Environment Variables for credentials
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const MINI_APP_URL = process.env.MINI_APP_URL || 'https://poputki.online';
  const BACKEND_API_URL = process.env.BACKEND_API_URL || 'https://poputki-backend.onrender.com/api';
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  const log = (msg, data = null) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${msg}`, data ? JSON.stringify(data) : '');
  };

  // Helper: Secure sendMessage with logging
  const safeSendMessage = async (payload) => {
    try {
      log(`Sending message to ${payload.chat_id}:`, payload.text);
      const response = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      log(`Telegram API Result for ${payload.chat_id}:`, result);
      return result;
    } catch (e) {
      log(`Telegram API Error for ${payload.chat_id}:`, e.message);
      return null;
    }
  };

  // Helper: Secure setMessageReaction with logging
  const safeSetReaction = async (chatId, messageId, emoji) => {
    try {
      log(`Setting reaction ${emoji || 'CLEAR'} for message ${messageId} in chat ${chatId}`);
      const body = {
        chat_id: chatId,
        message_id: messageId,
        is_big: false
      };
      if (emoji) {
        body.reaction = [{ type: 'emoji', emoji: emoji }];
      } else {
        body.reaction = [];
      }
      const response = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/setMessageReaction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const result = await response.json();
      log(`setMessageReaction API Result:`, result);
      return result;
    } catch (e) {
      log(`setMessageReaction API Error:`, e.message);
      return null;
    }
  };

  // Helper: Ban chat member with logging
  const safeBanMember = async (chatId, userId) => {
    try {
      log(`Banning user ${userId} from chat ${chatId}`);
      const response = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/banChatMember`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          user_id: userId
        })
      });
      const result = await response.json();
      log(`banChatMember result:`, result);
      return result;
    } catch (e) {
      log(`banChatMember error:`, e.message);
      return null;
    }
  };

  // Helper: Delete message with logging
  const safeDeleteMessage = async (chatId, messageId) => {
    try {
      log(`Deleting message ${messageId} from chat ${chatId}`);
      const response = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId
        })
      });
      const result = await response.json();
      log(`deleteMessage result:`, result);
      return result;
    } catch (e) {
      log(`deleteMessage error:`, e.message);
      return null;
    }
  };

  // Claude API Configuration & Helpers
  const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

  const syncGroup = async (cid, title) => {
    try {
      log(`syncGroup starting for chat: ${cid} (${title})`);
      const response = await fetch(`${SUPABASE_URL}/rest/v1/telegram_groups`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-dupes'
        },
        body: JSON.stringify({
          chat_id: cid.toString(),
          title: title
        })
      });
      log(`syncGroup result status: ${response.status}`);
      return { ok: response.ok, status: response.status, text: async () => response.text() };
    } catch (e) {
      log('syncGroup error:', e);
      return { ok: false, status: 500, text: async () => e.message };
    }
  };

  const parseMessageWithClaude = async (text) => {
    try {
      if (!CLAUDE_API_KEY) {
        log('Claude API Key is not configured in environment variables. Skipping AI parsing.');
        return {};
      }
      log('Sending message to Claude API...');
      const today = new Date();
      // Get Tajik/Dushanbe local time offset (typically UTC+5)
      const tajikTime = new Date(today.getTime() + (5 * 60 * 60 * 1000));
      const currentDateLocal = tajikTime.toISOString().split('T')[0];
      const currentHourLocal = tajikTime.toISOString().split('T')[1];

      const systemPrompt = `You are an expert system that extracts ride details from Telegram group messages written by taxi drivers (looking for passengers) or passengers (looking for taxi drivers) in Tajikistan (who speak Tajik, Russian, Uzbek or a mix).
Your task is to identify if a message contains a ride or trip announcement (by either driver or passenger), and if it does, extract the details into a JSON object. In ride announcements as driver you can look for keywords : "лозим","мерам","даркор". 

Allowed Tajikistan Cities (normalize any parsed city names, nearby towns, border checkpoints, suburbs, typos, or spelling variations to match one of these EXACT Tajik city names):
- "Душанбе" 
- "Худжанд" 
- "Бохтар" 
- "Куляб" 
- "Истаравшан"
- "Хорог" 
- "Гиссар"
- "Ойбек" 
- "Турсунзаде" 
- "Канибадам"
- "Исфара" 
- "Пенджикент"

CRITICAL RULE:
Your extracted 'from_city' and 'to_city' should not strictly be one of the city names listed above. If a completely new unknown city name is detected, you can include that in the JSON as well.
You MUST neglect minor spelling discrepancies, typos, or specific micro-locations, and dynamically map them to the CLOSEST allowed major city if it's within that city's vicinity or is a common spelling of it.

Look specifically for the following parameters:
- from_city (string, normalized to one of the allowed cities above if possible)
- to_city (string, normalized to one of the allowed cities above if possible)
- date (string, in YYYY-MM-DD format. Today is ${currentDateLocal}. Resolve relative dates like 'today' (${currentDateLocal}), 'tomorrow', 'Monday', '18.05' based on today's date). Remember the word "пага" - means tomorrow in tajik
- time (string, in HH:MM format, e.g., '14:30'. If time is not found, default to '12:00' or resolve based on context, e.g. morning -> '08:00', evening -> '18:00', afternoon -> '14:00')
- phone (string, formatted phone number of the driver or passenger, e.g., '+992900000000')
- price (integer, price in Somoni. If not found, use null)
- is_passenger_entry (boolean, true if the message is written by passenger(s) looking for a driver/ride, false if written by a driver offering a ride/looking for passengers)
- seats (integer, number of seats. If is_passenger_entry is true, this is the number of passengers looking for a ride [default 1]. If is_passenger_entry is false, this is the number of free seats available in the car [default 4])
- allows_delivery (boolean, whether the driver accepts packages/deliveries. If is_passenger_entry is true, set this to false. If not found or negative, use false)


Minimum requirements:
1. Origin and destination (from_city and to_city) must be found.
2. A valid phone number must be found.

Also if the exact time of the trip is not indicated in the message at all, take this time : ${currentHourLocal} and add four hours, then use it in your json response - meaning four hours past this time.

If these minimum requirements are met, return ONLY a valid JSON object. Do not include any markdown formatting, backticks, or extra text. Just a pure JSON block.
If the minimum requirements are not met or the message is not a ride/trip announcement, return an empty JSON object: {}

JSON Keys:
{
  "from_city": "...",
  "to_city": "...",
  "date": "...",
  "time": "...",
  "phone": "...",
  "price": ...,
  "is_passenger_entry": ...,
  "seats": ...,
  "allows_delivery": ...
}`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 1024,
          messages: [
            { role: 'user', content: `Analyze this message:\n"${text}"\n\nSystem Prompt: ${systemPrompt}` }
          ]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Claude API returned status ${response.status}: ${errText}`);
      }

      const data = await response.json();
      log('Claude API Response received:', data);

      const contentText = data.content[0].text.trim();
      log('Claude parsed text content:', contentText);

      let cleanedJson = contentText;
      if (cleanedJson.startsWith('```')) {
        cleanedJson = cleanedJson.replace(/^```json\s*/, '').replace(/```$/, '').trim();
      }

      const result = JSON.parse(cleanedJson);
      return result;
    } catch (e) {
      log('parseMessageWithClaude error: ' + e.message + '\n' + e.stack);
      return {};
    }
  };

  const checkSpamWithClaude = async (text) => {
    try {
      if (!CLAUDE_API_KEY) {
        log('Claude API Key is not configured in environment variables. Skipping spam check.');
        return { is_spam: false, spam_type: 'normal', confidence: 'low', reason: 'Claude API key not configured' };
      }
      log('Checking message for spam with Claude...');
      const systemPrompt = `You are a moderation system for a ride-sharing Telegram group in Tajikistan. The group language is Russian and Tajik.

Your task is to determine if a message is spam, fraud, or unwanted commercial content.

Types of spam/fraud to look for:
- Job announcements ("работа", "вакансия", "заработок", "подработка", "зарплата")
- Side hustle offers ("легкий заработок", "пассивный доход", "на дому", "удаленно")
- Advertisements ("реклама", "услуги", "предложение", "скидки")
- Pyramid schemes / MLM / investment scams
- Phishing or suspicious links
- Fake profiles or impersonation
- Any commercial promotion not related to ride-sharing

If the message appears to be legitimate (ride announcement, general conversation, question about rides, etc.), classify it as normal.

Return ONLY a valid JSON object. No markdown, no backticks, just pure JSON:
{
  "is_spam": true or false,
  "spam_type": "spam" | "fraud" | "normal",
  "confidence": "high" | "medium" | "low",
  "reason": "brief explanation in Russian"
}

Set is_spam to true ONLY if confidence is "high". For anything uncertain, set is_spam to false.`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 256,
          messages: [
            { role: 'user', content: `Analyze this message for spam:\n"${text}"\n\nSystem Prompt: ${systemPrompt}` }
          ]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Claude API returned status ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const contentText = data.content[0].text.trim();

      let cleaned = contentText;
      if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/```$/, '').trim();
      }

      return JSON.parse(cleaned);
    } catch (e) {
      log('checkSpamWithClaude error: ' + e.message);
      return { is_spam: false, spam_type: "normal", confidence: "low" };
    }
  };

  const handleGroupMessage = async (msg) => {
    if (msg.from && msg.from.is_bot) {
      log(`[Scraper] Skipping message from bot: ${msg.from.username}`);
      return;
    }
    const text = msg.text;
    log(`[Scraper] Processing group message: "${text.substring(0, 100)}..."`);

    // Set active reading/scraping reaction instantly
    await safeSetReaction(msg.chat.id, msg.message_id, '👀');

    try {
      const parsed = await parseMessageWithClaude(text);

      if (!parsed || !parsed.from_city || !parsed.to_city || !parsed.phone || !parsed.time) {
        log('[Scraper] Message is not a valid ride announcement or is missing required fields.');
        // Clear reaction if it's not a ride announcement
        await safeSetReaction(msg.chat.id, msg.message_id, '');

        // Check if the message is spam/fraud
        if (text && msg.from && msg.from.id) {
          const spamCheck = await checkSpamWithClaude(text);
          if (spamCheck && spamCheck.is_spam) {
            log(`[Spam] Detected spam from user ${msg.from.id}. Type: ${spamCheck.spam_type}, Reason: ${spamCheck.reason}`);
            await safeBanMember(msg.chat.id, msg.from.id);
            await safeDeleteMessage(msg.chat.id, msg.message_id);
            const userName = escapeHtml(msg.from.first_name || msg.from.username || 'Пользователь');
            await safeSendMessage({
              chat_id: msg.chat.id,
              text: `🚫 Пользователь ${userName} заблокирован за спам.`
            });
          }
        }

        return;
      }

      log('[Scraper] Claude parsed ride successfully:', parsed);

      const ALLOWED_CITIES = ["Душанбе", "Худжанд", "Бохтар", "Куляб", "Хорог", "Гиссар", "Ойбек", "Турсунзаде", "Канибадам", "Исфара", "Пенджикент"];
      const fromCityNormalized = ALLOWED_CITIES.find(c => c.toLowerCase() === parsed.from_city.trim().toLowerCase());
      const toCityNormalized = ALLOWED_CITIES.find(c => c.toLowerCase() === parsed.to_city.trim().toLowerCase());

      if (!fromCityNormalized || !toCityNormalized) {
        log(`[Scraper] Rejected: Normalized cities not found. Raw from: "${parsed.from_city}", to: "${parsed.to_city}"`);
        // Clear reaction if cities not found
        await safeSetReaction(msg.chat.id, msg.message_id, '');
        return;
      }

      let phone = parsed.phone.replace(/[\s\-\(\)]/g, '');
      if (phone.startsWith('9')) {
        phone = '+992' + phone;
      } else if (phone.startsWith('8') && phone.length === 11) {
        phone = '+' + phone;
      } else if (!phone.startsWith('+')) {
        phone = '+' + phone;
      }

      log('[Scraper] Resolving Ронанда superuser...');
      const scraperUserId = 694; // Optimized directly to production ID to avoid slow database calls
      log(`[Scraper] Using Ронанда superuser ID: ${scraperUserId}`);

      const dateStr = parsed.date;

      // Enforce duplicate protection: search for active scraped rides with this route, date, and original driver's phone in description
      const dupQueryUrl = `${SUPABASE_URL}/rest/v1/rides?driver_id=eq.${scraperUserId}&from_city=eq.${encodeURIComponent(fromCityNormalized)}&to_city=eq.${encodeURIComponent(toCityNormalized)}&date=eq.${dateStr}&status=eq.active&description=ilike.*${phone.replace('+', '')}*&select=id`;
      const dupRes = await fetch(dupQueryUrl, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      });

      if (dupRes.ok) {
        const dupRides = await dupRes.json();
        if (dupRides && dupRides.length > 0) {
          log(`[Scraper] Skip creation: Duplicate active ride already exists for this driver on this day, ID: ${dupRides[0].id}`);
          // Set checked/duplicate reaction
          await safeSetReaction(msg.chat.id, msg.message_id, '✅');
          return;
        }
      }

      let timeFormatted = parsed.time;
      if (timeFormatted && timeFormatted.length === 5) {
        timeFormatted += ':00';
      }

      const isPassenger = !!parsed.is_passenger_entry;
      const authorRoleName = isPassenger ? 'Пассажир' : 'Водитель';
      const originalAuthorName = parsed.name || (msg.from ? `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() : '') || authorRoleName;
      const contactInfo = `\n\n👤 Имя: ${originalAuthorName}\n📞 Контакты: ${phone}`;
      const description = text + contactInfo;

      const scraperMetadata = {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        user_id: msg.from ? msg.from.id : null,
        username: msg.from ? msg.from.username : null,
        first_name: msg.from ? msg.from.first_name : null,
        last_name: msg.from ? msg.from.last_name : null,
        phone: phone
      };

      const rideData = {
        driver_id: scraperUserId,
        from_city: fromCityNormalized,
        to_city: toCityNormalized,
        date: dateStr,
        time: timeFormatted,
        price: parsed.price || 100,
        seats: parsed.seats || (isPassenger ? 1 : 4),
        description: description,
        is_passenger_entry: isPassenger,
        reserved_seats: [],
        allows_delivery: isPassenger ? false : !!parsed.allows_delivery,
        status: 'active',
        from_address: '',
        to_address: '',
        total_seats: isPassenger ? (parsed.seats || 1) : ((parsed.seats || 4) + 1),
        scraper_metadata: scraperMetadata
      };

      log(`[Scraper] Calling backend API to publish ride: ${BACKEND_API_URL}/rides`);

      const botServiceToken = process.env.BOT_SERVICE_TOKEN;
      const backendResponse = await fetch(`${BACKEND_API_URL}/rides`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(botServiceToken ? { 'X-Bot-Service-Token': botServiceToken } : {})
        },
        body: JSON.stringify(rideData)
      });

      if (!backendResponse.ok) {
        const errText = await backendResponse.text();
        throw new Error(`Backend API returned status ${backendResponse.status}: ${errText}`);
      }

      const newRide = await backendResponse.json();
      const newRideId = newRide.id;
      log(`[Scraper] SUCCESS! Published ride ID via backend: ${newRideId}`);

      // Set successful publication reaction
      await safeSetReaction(msg.chat.id, msg.message_id, '👍');

      if (msg.from && msg.from.id) {
        const rideUrl = `${MINI_APP_URL}/ride/${newRideId}`;
        let personalMsg = '';
        if (isPassenger) {
          personalMsg = `🤖 <b>Заявка автоматически опубликована!</b>\n\nНаш бот распознал ваше сообщение в группе:\n📍 <b>Маршрут:</b> ${fromCityNormalized} ➡ ${toCityNormalized}\n🗓 <b>Дата:</b> ${dateStr}\n⏰ <b>Время:</b> ${parsed.time}\n🙋‍♂️ <b>Пассажиров:</b> ${rideData.seats}\n💰 <b>Цена:</b> ${rideData.price} с.\n\n<i>Вы можете открыть вашу заявку в приложении:</i>`;
        } else {
          const deliveryText = rideData.allows_delivery ? '\n📦 <b>Беру посылки</b>' : '';
          personalMsg = `🤖 <b>Поездка автоматически опубликована!</b>\n\nНаш бот распознал ваше сообщение в группе:\n📍 <b>Маршрут:</b> ${fromCityNormalized} ➡ ${toCityNormalized}\n🗓 <b>Дата:</b> ${dateStr}\n⏰ <b>Время:</b> ${parsed.time}\n💺 <b>Свободных мест:</b> ${rideData.seats}\n💰 <b>Цена:</b> ${rideData.price} с.${deliveryText}\n\n<i>Вы можете открыть вашу поездку в приложении:</i>`;
        }

        await safeSendMessage({
          chat_id: msg.from.id,
          text: personalMsg,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [[{ text: isPassenger ? 'Открыть заявку' : 'Открыть поездку', web_app: { url: rideUrl } }]]
          }
        });
      }
    } catch (err) {
      log('[Scraper] Error during handleGroupMessage: ' + err.message + '\n' + err.stack);
      // Set warning reaction on error (using standard '⚡' emoji since '⚠️' is not supported by default reactions)
      await safeSetReaction(msg.chat.id, msg.message_id, '⚡');
    }
  };

  // --- GET Setup & Diagnostic Endpoint ---
  if (req.method === "GET") {
    const { url, status } = req.query;

    if (status) {
      try {
        log("Diagnostic requested. Fetching info...");
        const webhookInfoRes = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/getWebhookInfo`);
        const webhookInfo = await webhookInfoRes.json();
        const meRes = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/getMe`);
        const me = await meRes.json();

        if (!webhookInfo.ok) {
          return res.status(200).json({ ok: false, error: "Telegram getWebhookInfo failed", details: webhookInfo });
        }
        if (!me.ok) {
          return res.status(200).json({ ok: false, error: "Telegram getMe failed", details: me });
        }

        let selfHealingStatus = "Healthy";
        if (webhookInfo.result && !webhookInfo.result.url) {
          log("Webhook missing! Attempting self-healing...");
          const webhookUrl = `https://${req.headers.host}/api/bot`;
          const setRes = await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url: webhookUrl,
              allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member", "chat_member"]
            })
          });
          const setResult = await setRes.json();
          selfHealingStatus = `Self-healed result: ${JSON.stringify(setResult)}`;
        }

        return res.status(200).json({
          ok: true,
          version: "4.0.0",
          self_healing: selfHealingStatus,
          bot: me.result,
          webhook: webhookInfo.result,
          config: {
            MINI_APP_URL,
            SUPABASE_URL
          }
        });
      } catch (err) {
        return res.status(500).json({ ok: false, error: err.message, stack: err.stack });
      }
    }

    try {
      const webhookUrl = url || `https://${req.headers.host}/api/bot`;
      const setWebhookUrl = `${TELEGRAM_API}/bot${BOT_TOKEN}/setWebhook`;

      log(`Setting webhook to: ${webhookUrl}`);

      const response = await fetch(setWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          allowed_updates: ["message", "edited_message", "my_chat_member", "chat_member", "callback_query"]
        })
      });

      const data = await response.json();
      return res.status(200).send(`
        <html>
          <body style="font-family: sans-serif; padding: 40px; text-align: center; background: #f9fafb;">
            <div style="max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
              <h1 style="color: ${data.ok ? '#22c55e' : '#ef4444'}">${data.ok ? '✅ Webhook Setup Successful' : '❌ Webhook Setup Failed'}</h1>
              <p style="color: #4b5563;">Webhook URL: <code style="background: #f3f4f6; padding: 2px 6px; border-radius: 4px;">${webhookUrl}</code></p>
              <div style="text-align: left; margin-top: 20px;">
                <p style="font-weight: bold; margin-bottom: 8px;">Telegram Response:</p>
                <pre style="background: #1f2937; color: #f9fafb; padding: 15px; border-radius: 8px; overflow-x: auto; font-size: 14px;">${JSON.stringify(data, null, 2)}</pre>
              </div>
              <p style="margin-top: 20px; color: #6b7280; font-size: 14px;">Allowed Updates: <b>message, edited_message, callback_query, my_chat_member, chat_member</b></p>
              <div style="margin-top: 30px; border-top: 1px solid #e5e7eb; padding-top: 20px;">
                <a href="/api/bot?status=1" style="color: #3b82f6; text-decoration: none; font-weight: 500;">Check Full Status</a>
                <span style="margin: 0 15px; color: #d1d5db;">|</span>
                <a href="${MINI_APP_URL}" style="color: #3b82f6; text-decoration: none; font-weight: 500;">Go to App</a>
              </div>
            </div>
          </body>
        </html>
      `);
    } catch (err) {
      log(`Setup Error: ${err.message}`);
      return res.status(500).send(`Error: ${err.message}`);
    }
  }

  if (req.method === "HEAD") {
    return res.status(200).end();
  }

  if (req.method !== "POST" && req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const update = req.body;
    log(`Incoming ${req.method} update:`, update);

    // Handle Poll Answer
    const pollAnswer = update.poll_answer;
    if (pollAnswer) {
      log(`Received poll answer for poll ${pollAnswer.poll_id} from user ${pollAnswer.user.id}`);
      
      const sentPollUrl = `${SUPABASE_URL}/rest/v1/sent_polls?poll_id=eq.${pollAnswer.poll_id}&select=*`;
      const sentResponse = await fetch(sentPollUrl, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      });
      
      if (sentResponse.ok) {
        const sentData = await sentResponse.json();
        const sentPoll = sentData && sentData[0];
        
        if (sentPoll) {
          const { booking_id, user_id, telegram_id } = sentPoll;
          const selectedOptionIndex = pollAnswer.option_ids[0];
          
          if (selectedOptionIndex !== undefined) {
            if (selectedOptionIndex === 3) {
              // Custom option ("Ваш вариант") selected. Set bot state.
              const clearStateUrl = `${SUPABASE_URL}/rest/v1/bot_user_states?telegram_id=eq.${telegram_id}`;
              await fetch(clearStateUrl, {
                method: 'DELETE',
                headers: {
                  'apikey': SUPABASE_ANON_KEY,
                  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                }
              });

              const stateUrl = `${SUPABASE_URL}/rest/v1/bot_user_states`;
              await fetch(stateUrl, {
                method: 'POST',
                headers: {
                  'apikey': SUPABASE_ANON_KEY,
                  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  telegram_id: telegram_id,
                  state: 'waiting_for_poll_custom_answer',
                  data: { booking_id, user_id }
                })
              });

              await safeSendMessage({
                chat_id: telegram_id,
                text: "Пожалуйста, напишите текстовым сообщением, что именно помешало вам оформить билет."
              });
            } else {
              // Predefined option selected
              const settingsUrl = `${SUPABASE_URL}/rest/v1/poll_settings?id=eq.1&select=*`;
              const settingsResponse = await fetch(settingsUrl, {
                headers: {
                  'apikey': SUPABASE_ANON_KEY,
                  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                }
              });
              
              let optionText = 'Unknown option';
              if (settingsResponse.ok) {
                const settingsData = await settingsResponse.json();
                const settings = settingsData && settingsData[0];
                if (settings) {
                  if (selectedOptionIndex === 0) optionText = settings.option1;
                  else if (selectedOptionIndex === 1) optionText = settings.option2;
                  else if (selectedOptionIndex === 2) optionText = settings.option3;
                }
              }

              const answerUrl = `${SUPABASE_URL}/rest/v1/purchase_poll_answers`;
              await fetch(answerUrl, {
                method: 'POST',
                headers: {
                  'apikey': SUPABASE_ANON_KEY,
                  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  booking_id,
                  user_id,
                  telegram_id,
                  answer: optionText
                })
              });

              await safeSendMessage({
                chat_id: telegram_id,
                text: "Спасибо за ваш ответ! Это поможет нам сделать сервис лучше."
              });
            }
          }
        }
      }
      return res.status(200).json({ ok: true });
    }

    // Support multiple update types
    const message = update.message || update.edited_message || update.channel_post || update.edited_channel_post;
    const callbackQuery = update.callback_query;
    const memberUpdate = update.my_chat_member || update.chat_member;

    if (!message && !memberUpdate && !callbackQuery) {
      return res.status(200).json({ ok: true });
    }

    // Handle Callback Queries
    if (callbackQuery) {
      const chatId = callbackQuery.message.chat.id;
      const data = callbackQuery.data;
      log(`Callback query from chat ${chatId}: ${data}`);

      // Acknowledge callback query
      await fetch(`${TELEGRAM_API}/bot${BOT_TOKEN}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callback_query_id: callbackQuery.id })
      });

      return res.status(200).json({ ok: true });
    }

    // Extract chat details
    const chat = (message || memberUpdate || (callbackQuery ? callbackQuery.message : {})).chat;
    if (!chat || !chat.id) return res.status(200).json({ ok: true });

    const chatId = chat.id;
    const chatType = chat.type;
    const chatTitle = chat.title || chat.first_name || 'Personal Chat';

    // Helper: Escape HTML
    const escapeHtml = (unsafe) => {
      if (!unsafe || typeof unsafe !== 'string') return unsafe;
      return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    };

    // 1. Group / Supergroup / Channel logic -> Save to Supabase
    if (chatType === 'group' || chatType === 'supergroup' || chatType === 'channel') {
      let syncRes = null;
      if (!syncedGroups.has(chatId)) {
        syncRes = await syncGroup(chatId, chatTitle);
        if (syncRes && syncRes.ok) {
          syncedGroups.add(chatId);
        }
        log(`Group sync result for ${chatId}: ${syncRes ? syncRes.status : 'N/A'}`);
      } else {
        log(`Group ${chatId} already synced in-memory, skipping DB write`);
      }

      // Handle /test command for verification
      if (message && message.text && message.text.startsWith('/test')) {
        let statusMsg = "DB Sync Status: ";
        if (syncRes && syncRes.ok) {
          statusMsg += "✅ SUCCESS! Group ID saved/verified.";
        } else if (syncedGroups.has(chatId)) {
          statusMsg += "✅ SUCCESS! Group is already synced (in-memory cached).";
        } else {
          const errText = syncRes ? await syncRes.text() : "Sync not triggered";
          statusMsg += `❌ FAILED. ${errText}`;
        }
        await safeSendMessage({ chat_id: chatId, text: statusMsg });
      }

      // Automated ride parsing
      if (message && message.text && !message.text.startsWith('/')) {
        await handleGroupMessage(message);
      }

      return res.status(200).json({ ok: true });
    }

    // 2. Private chat logic -> Handle /start or Send Mini App Button
    if (chatType === 'private' && (message || callbackQuery)) {
      const text = message ? (message.text || "") : "";
      log(`Private event from ${chatId}: ${text || '[no text]'}`);

      // Check if user is in a poll custom answer state
      const stateUrl = `${SUPABASE_URL}/rest/v1/bot_user_states?telegram_id=eq.${chatId}&select=*`;
      const stateResponse = await fetch(stateUrl, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      });
      
      let userState = null;
      if (stateResponse.ok) {
        const stateData = await stateResponse.json();
        userState = stateData && stateData[0];
      }

      if (userState && userState.state === 'waiting_for_poll_custom_answer' && text && !text.startsWith('/')) {
        log(`User ${chatId} provided custom poll answer: "${text}"`);
        const { booking_id, user_id } = userState.data || {};
        
        const answerUrl = `${SUPABASE_URL}/rest/v1/purchase_poll_answers`;
        await fetch(answerUrl, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            booking_id: booking_id,
            user_id: user_id,
            telegram_id: chatId.toString(),
            answer: text
          })
        });

        const clearStateUrl = `${SUPABASE_URL}/rest/v1/bot_user_states?telegram_id=eq.${chatId}`;
        await fetch(clearStateUrl, {
          method: 'DELETE',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
          }
        });

        await safeSendMessage({
          chat_id: chatId,
          text: "Спасибо за ваш ответ! Это поможет нам сделать сервис лучше."
        });
        
        return res.status(200).json({ ok: true });
      }

      if (text === '/ping') {
        await safeSendMessage({ chat_id: chatId, text: "Pong! 🏓 Bot is active." });
        return res.status(200).json({ ok: true });
      }

      // Handle /start command (both with and without params)
      if (text.startsWith('/start')) {
        // Clear state just in case they were waiting for custom answer
        const clearStateUrl = `${SUPABASE_URL}/rest/v1/bot_user_states?telegram_id=eq.${chatId}`;
        await fetch(clearStateUrl, {
          method: 'DELETE',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
          }
        });

        const parts = text.split(' ');
        const param = parts.length > 1 ? parts[1] : null;

        if (param) {
          log(`Handling deep link with param: ${param}`);

          if (param.startsWith('ride_')) {
            const rideId = param.replace('ride_', '');
            // Check if rideId is a valid number
            if (!/^\d+$/.test(rideId)) {
              await safeSendMessage({
                chat_id: chatId,
                text: "😔 Неверный формат ссылки на поездку."
              });
              return res.status(200).json({ ok: true });
            }

            try {
              const rideUrl = `${SUPABASE_URL}/rest/v1/rides?id=eq.${rideId}&select=*`;
              const rideResponse = await fetch(rideUrl, {
                headers: {
                  'apikey': SUPABASE_ANON_KEY,
                  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                }
              });

              if (!rideResponse.ok) {
                const errorText = await rideResponse.text();
                throw new Error(`Supabase error ${rideResponse.status}: ${errorText}`);
              }

              const rideDataArray = await rideResponse.json();
              const ride = Array.isArray(rideDataArray) ? rideDataArray[0] : null;

              if (ride) {
                const dateStr = ride.date;
                const timeStr = ride.time ? ride.time.substring(0, 5) : '';
                let msg = "";
                const fromCity = escapeHtml(ride.from_city);
                const toCity = escapeHtml(ride.to_city);

                if (ride.is_passenger_entry) {
                  msg = `🙋 <b>ПАССАЖИР ИЩЕТ ПОЕЗДКУ</b>\n\n📍 <b>Маршрут:</b> ${fromCity} ➡ ${toCity}\n🗓 <b>Дата:</b> ${dateStr}\n⏰ <b>Время:</b> ${timeStr}`;
                } else {
                  const deliveryText = ride.allows_delivery ? '\n📦 <b>Беру посылки</b>' : '';
                  msg = `🚗 <b>ВОДИТЕЛЬ ИЩЕТ ПАССАЖИРОВ</b>\n\n📍 <b>Маршрут:</b> ${fromCity} ➡ ${toCity}\n🗓 <b>Дата:</b> ${dateStr}\n⏰ <b>Время:</b> ${timeStr}\n💺 <b>Свободных мест:</b> ${ride.seats}${deliveryText}`;
                }

                await safeSendMessage({
                  chat_id: chatId,
                  text: msg,
                  parse_mode: "HTML",
                  reply_markup: {
                    inline_keyboard: [[{ text: "🚀 Открыть в приложении", web_app: { url: `${MINI_APP_URL}/ride/${rideId}` } }]]
                  }
                });
                return res.status(200).json({ ok: true });
              } else {
                await safeSendMessage({
                  chat_id: chatId,
                  text: "😔 Данная поездка не найдена или уже не актуальна."
                });
                return res.status(200).json({ ok: true });
              }
            } catch (e) {
              log('Fetch ride error:', e);
              await safeSendMessage({
                chat_id: chatId,
                text: `😔 Ошибка при поиске поездки: ${e.message}`
              });
              return res.status(200).json({ ok: true });
            }
          }

          if (param.startsWith('bus_')) {
            const raw = param.replace('bus_', '');
            const parts = raw.split('_');
            const busId = parts[0];
            const refToken = parts.slice(1).join('_');

            // Check if busId is a valid number
            if (!/^\d+$/.test(busId)) {
              await safeSendMessage({
                chat_id: chatId,
                text: "😔 Неверный формат ссылки на билет."
              });
              return res.status(200).json({ ok: true });
            }

            try {
              const busUrl = `${SUPABASE_URL}/rest/v1/bus_tickets?id=eq.${busId}&select=*`;
              const busResponse = await fetch(busUrl, {
                headers: {
                  'apikey': SUPABASE_ANON_KEY,
                  'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
                }
              });

              if (!busResponse.ok) {
                const errorText = await busResponse.text();
                throw new Error(`Supabase error ${busResponse.status}: ${errorText}`);
              }

              const busDataArray = await busResponse.json();
              const bus = Array.isArray(busDataArray) ? busDataArray[0] : null;

              if (bus) {
                const dateStr = bus.departure_date;
                const timeStr = bus.departure_time ? bus.departure_time.substring(0, 5) : '';
                const fromCity = escapeHtml(bus.from_city);
                const toCity = escapeHtml(bus.to_city);
                const company = escapeHtml(bus.transport_company);

                const stops = (typeof bus.intermediate_stops === 'string' ? JSON.parse(bus.intermediate_stops || '[]') : (bus.intermediate_stops || []));
                const stopsText = stops.length > 0 ? `\n🛑 <b>Остановки:</b> ${stops.map(s => escapeHtml(s.city)).join(', ')}` : '';

                const msg = `🚌 <b>АВТОБУСНЫЙ РЕЙС</b>\n\n📍 <b>Маршрут:</b> ${fromCity} ➡ ${toCity}${stopsText}\n🗓 <b>Дата:</b> ${dateStr}\n⏰ <b>Время:</b> ${timeStr}\n💰 <b>Цена:</b> ${bus.price} сом\n🏢 <b>Перевозчик:</b> ${company}`;

                let appUrl = `${MINI_APP_URL}/bus-ticket/${busId}`;
                if (refToken) {
                  const cleanRef = refToken.replace(/^[cr]_?/, '');
                  appUrl += `?source=carrier_link&ref=c_${cleanRef}&channel=telegram`;
                }

                await safeSendMessage({
                  chat_id: chatId,
                  text: msg,
                  parse_mode: "HTML",
                  reply_markup: {
                    inline_keyboard: [[{ text: "🚀 Открыть билет", web_app: { url: appUrl } }]]
                  }
                });
                return res.status(200).json({ ok: true });
              } else {
                await safeSendMessage({
                  chat_id: chatId,
                  text: "😔 Данный билет не найден или уже не актуален."
                });
                return res.status(200).json({ ok: true });
              }
            } catch (e) {
              log('Fetch bus error:', e);
              await safeSendMessage({
                chat_id: chatId,
                text: `😔 Ошибка при поиске билета: ${e.message}`
              });
              return res.status(200).json({ ok: true });
            }
          }
        }
      }

      // Check AI Assistant Client (Fail-closed: if disabled/unconfigured/timeout/unauthorized, proceeds to static menu)
      if (text && !text.startsWith('/')) {
        const aiResult = await callAssistantChat({
          updateId: update.update_id || Date.now(),
          telegramId: message?.from?.id || chatId,
          chatId: chatId,
          message: text
        });

        if (aiResult.ok && aiResult.reply) {
          const inlineKeyboard = [];
          if (Array.isArray(aiResult.trips) && aiResult.trips.length > 0) {
            for (const trip of aiResult.trips) {
              const btnText = trip.type === 'bus'
                ? `🚌 Автобус ${trip.from_city} → ${trip.to_city} (${trip.price_somoni} с.)`
                : `🚗 Поездка ${trip.from_city} → ${trip.to_city} (${trip.price_somoni} с.)`;
              const appUrl = `${MINI_APP_URL}${trip.booking_path}`;
              inlineKeyboard.push([{ text: btnText, web_app: { url: appUrl } }]);
            }
          }
          inlineKeyboard.push([{ text: "🔍 Найти поездку в приложении", web_app: { url: `${MINI_APP_URL}/search` } }]);

          await safeSendMessage({
            chat_id: chatId,
            text: aiResult.reply.slice(0, 4000),
            reply_markup: { inline_keyboard: inlineKeyboard }
          });
          return res.status(200).json({ ok: true });
        }
      }

      // Default Welcome Message (Fallback)
      const welcomeText = "Poputki.online – это современное приложение, которое делает междугородние поездки проще и выгоднее.\nТы еще ждешь?\n👇ЖМИ👇";

      const persistentMenu = {
        keyboard: [
          [{ text: "Создать поездку", web_app: { url: `${MINI_APP_URL}/create` } }, { text: "Найти поездку", web_app: { url: `${MINI_APP_URL}/search` } }],
          [{ text: "Мои поездки", web_app: { url: `${MINI_APP_URL}/my-rides` } }, { text: "Профиль", web_app: { url: `${MINI_APP_URL}/profile` } }]
        ],
        resize_keyboard: true,
        is_persistent: true
      };

      await safeSendMessage({
        chat_id: chatId,
        text: "Используйте меню ниже для быстрого доступа к функциям или нажмите кнопку:",
        reply_markup: persistentMenu
      });

      await safeSendMessage({
        chat_id: chatId,
        text: welcomeText,
        reply_markup: {
          inline_keyboard: [[{ text: "Открыть приложение", web_app: { url: `${MINI_APP_URL}/search` } }]]
        }
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    log('Handler Exception:', err);
    // Always return 200 to Telegram to prevent retry loops on crash
    return res.status(200).json({ ok: true, error: err.message });
  }
}
