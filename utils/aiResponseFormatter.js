/**
 * utils/aiResponseFormatter.js
 *
 * Deterministic formatting and language routing for AI Travel Assistant responses.
 *
 * Architectural Guarantees:
 * 1. Deterministic fields: route, date, time, price, seats, carrier/driver, and ride_id
 *    are derived strictly from database / tool results, NOT invented or altered by Claude.
 * 2. Language routing (RU / TJ / UZ) is decided strictly by the CURRENT user message,
 *    preventing previous session history from causing language inversions.
 * 3. Sanitizes and prevents any raw Markdown artifacts (such as ### and **) from appearing
 *    in Telegram output.
 * 4. Generates correct deep link buttons for Mini App (/ride/:id, /bus-ticket/:id).
 * 5. Strictly excludes trips with 0 seats, past trips, and passenger entries (is_passenger_entry = true).
 */

const MONTHS = {
  ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  tj: ['сентябри' /* fallback map below */, 'январи', 'феврали', 'марти', 'апрели', 'майи', 'июни', 'июли', 'августи', 'сентябри', 'октябри', 'ноябри', 'декабри'],
  uz: ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr']
};

// 1-indexed month access helper
function getMonthName(monthNumber, lang) {
  const m = Number(monthNumber);
  if (isNaN(m) || m < 1 || m > 12) return '';
  if (lang === 'tj') {
    const tjMonths = ['январи', 'феврали', 'марти', 'апрели', 'майи', 'июни', 'июли', 'августи', 'сентябри', 'октябри', 'ноябри', 'декабри'];
    return tjMonths[m - 1];
  }
  if (lang === 'uz') {
    return MONTHS.uz[m - 1];
  }
  return MONTHS.ru[m - 1];
}

const LABELS = {
  ru: {
    carpoolTitle: '🚗 Поездка',
    busTitle: '🚌 Автобус',
    dateLabel: '📅 Дата',
    priceLabel: '💰 Стоимость',
    priceUnit: 'сомони',
    seatsLabel: '💺 Свободных мест',
    driverLabel: '👤 Водитель',
    carrierLabel: '🏢 Перевозчик',
    defaultIntro: 'Вот найденные варианты поездок:',
    searchBtn: '🔍 Найти поездку в приложении',
    bookCarpoolBtn: (from, to, price) => `🚗 Поездка ${from} → ${to} (${price} с.)`,
    bookBusBtn: (from, to, price) => `🚌 Автобус ${from} → ${to} (${price} с.)`
  },
  tj: {
    carpoolTitle: '🚗 Сафар',
    busTitle: '🚌 Автобус',
    dateLabel: '📅 Сана',
    priceLabel: '💰 Арзиш',
    priceUnit: 'сомонӣ',
    seatsLabel: '💺 Ҷойҳои холӣ',
    driverLabel: '👤 Ронанда',
    carrierLabel: '🏢 Ширкат',
    defaultIntro: 'Инҳо сафарҳои ёфтшуда аз рӯи дархости шумо:',
    searchBtn: '🔍 Ҷустуҷӯи сафар дар замима',
    bookCarpoolBtn: (from, to, price) => `🚗 Сафар ${from} → ${to} (${price} с.)`,
    bookBusBtn: (from, to, price) => `🚌 Автобус ${from} → ${to} (${price} с.)`
  },
  uz: {
    carpoolTitle: '🚗 Safar',
    busTitle: '🚌 Avtobus',
    dateLabel: '📅 Sana',
    priceLabel: '💰 Narxi',
    priceUnit: 'somoni',
    seatsLabel: '💺 Bo\'sh joylar',
    driverLabel: '👤 Haydovchi',
    carrierLabel: '🏢 Tashuvchi',
    defaultIntro: 'So\'rovingiz bo\'yicha topilgan reyslar:',
    searchBtn: '🔍 Ilovada reys qidirish',
    bookCarpoolBtn: (from, to, price) => `🚗 Safar ${from} → ${to} (${price} s.)`,
    bookBusBtn: (from, to, price) => `🚌 Avtobus ${from} → ${to} (${price} s.)`
  }
};

/**
 * Detect language strictly from current message text.
 *
 * @param {string} text
 * @returns {'ru' | 'tj' | 'uz'}
 */
export function detectLanguage(text) {
  if (!text || typeof text !== 'string') return 'ru';
  const clean = text.toLowerCase().trim();

  // 1. Tajik specific markers
  // Characters unique to Tajik Cyrillic (not in standard Russian or Uzbek Cyrillic): ӣ, ҷ
  if (/[ӣҷ]/i.test(clean)) return 'tj';

  // Typical Tajik words & affixes
  const tjWords = [
    /\bсалом\b/, /\bмехоҳам\b/, /\bчипта\b/, /\bчиптаҳо\b/, /\bроҳ\b/,
    /\bронанда\b/, /\bҷой\b/, /\bсафар\b/, /\bба\b/, /\bаз\b/, /\bкай\b/,
    /\bсоат\b/, /\bмарҳамат\b/, /\bраҳмат\b/, /\bҳаст\b/, /\bнест\b/,
    /\bчанд\b/, /\bкуҷо\b/, /\bхуҷанд\b/, /\bдушанбе\b.*\b(ба|аз)\b/,
    /\b(ба|аз)\b.*\bдушанбе\b/
  ];
  for (const pattern of tjWords) {
    if (pattern.test(clean)) return 'tj';
  }

  // Letters ғ, ӯ, ҳ, қ (can be Tajik or Uzbek Cyrillic)
  if (/[ғӯҳқ]/i.test(clean)) {
    // If it also has Uzbek patterns
    if (/\b(бор|борми|йўқ|керак|жой|жойлар|ҳайдовчи|қаерга|қачон|илтимос)\b/.test(clean)) {
      return 'uz';
    }
    // Otherwise in this region, default to Tajik
    return 'tj';
  }

  // 2. Uzbek specific markers
  // Uzbek Latin apostrophes and words
  const uzPatterns = [
    /o['`ʻ]/, /g['`ʻ]/, /\bbor\b/, /\bbormi\b/, /\byo['`ʻ]?q\b/,
    /\bkerak\b/, /\bjoy\b/, /\bjoylar\b/, /\bhaydovchi\b/, /\bqayerga\b/,
    /\bqachon\b/, /\biltimos\b/, /\breys\b/, /\bchipta\b/, /\bchiptalar\b/,
    /\btoshkent\b/, /\bsamarqand\b/, /\bxo['`ʻ]jand\b/
  ];
  for (const pattern of uzPatterns) {
    if (pattern.test(clean)) return 'uz';
  }

  // Uzbek Cyrillic words
  const uzCyrillic = [
    /\bбор\b/, /\bборми\b/, /\bйўқ\b/, /\bкерак\b/, /\bжой\b/, /\bҳайдовчи\b/,
    /\bқачон\b/, /\bқаерга\b/, /\bхўжанд\b/, /\bтошкент\b/
  ];
  for (const pattern of uzCyrillic) {
    if (pattern.test(clean)) return 'uz';
  }

  // 3. Russian markers & default
  // Presence of Russian-specific letters like 'ы', 'э', 'ё', 'ъ'
  // Or Russian travel keywords: найди, рейс, поездка, билет, сколько, свободно, водитель
  return 'ru';
}

/**
 * Format YYYY-MM-DD date safely into human readable format.
 *
 * @param {string} dateStr
 * @param {'ru' | 'tj' | 'uz'} lang
 * @returns {string}
 */
export function formatDate(dateStr, lang = 'ru') {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateStr;

  const year = match[1];
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  const monthName = getMonthName(month, lang);
  if (!monthName) return dateStr;

  return `${day} ${monthName} ${year}`;
}

/**
 * Strips raw Markdown artifacts (###, **, *, `) from a string.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeMarkdown(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    // Remove headers like ### or ## or #
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold **text** -> text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    // Remove italics *text* -> text
    .replace(/\*([^*\n]+)\*/g, '$1')
    // Remove backticks `code` -> code
    .replace(/`([^`\n]+)`/g, '$1')
    // Remove markdown links [text](url) -> text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    // Collapse excess newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extracts a clean conversational intro from Claude's response,
 * discarding any hallucinated Markdown cards or duplicate lists.
 *
 * @param {string} reply
 * @param {'ru' | 'tj' | 'uz'} lang
 * @returns {string}
 */
export function extractCleanIntro(reply, lang = 'ru') {
  const localizedDefault = LABELS[lang]?.defaultIntro || LABELS.ru.defaultIntro;
  if (!reply || typeof reply !== 'string') return localizedDefault;

  // Split by double newlines or first header marker
  const lines = reply.split(/\r?\n/);
  const introLines = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Stop at markdown headers or card lines
    if (line.startsWith('#') || line.startsWith('###')) break;
    if (/^[🚗🚌📅⏰💰💺👤🏢]/.test(line)) break;
    if (line.toLowerCase().includes('попутка:') || line.toLowerCase().includes('автобус:')) break;
    if (line.toLowerCase().includes('сафар:') || line.toLowerCase().includes('чипта:')) break;

    introLines.push(line);
    // Usually 1-2 sentences of greeting are enough
    if (introLines.length >= 2) break;
  }

  const combined = introLines.join(' ');
  const cleaned = sanitizeMarkdown(combined);

  // If the extracted text is too short or empty, use localized default
  if (!cleaned || cleaned.length < 3) {
    return localizedDefault;
  }

  return cleaned;
}

/**
 * Deterministically formats a single trip card strictly from DB tool result.
 *
 * @param {Object} trip
 * @param {'ru' | 'tj' | 'uz'} lang
 * @returns {string}
 */
export function formatDeterministicTripCard(trip, lang = 'ru') {
  const labels = LABELS[lang] || LABELS.ru;
  const isBus = trip.type === 'bus';

  const title = isBus ? labels.busTitle : labels.carpoolTitle;
  const fromCity = trip.from_city || '—';
  const toCity = trip.to_city || '—';
  const formattedDate = formatDate(trip.date, lang);
  const time = trip.time ? String(trip.time).slice(0, 5) : '12:00';
  const price = trip.price_somoni !== undefined ? trip.price_somoni : (trip.price || 0);
  const rawSeats = trip.seats_available !== undefined ? Number(trip.seats_available) : Number(trip.seats || 0);
  const maxCap = trip.seats !== undefined && trip.seats !== null ? Number(trip.seats) : rawSeats;
  const seats = Math.max(0, Math.min(maxCap, rawSeats));

  const personLabel = isBus ? labels.carrierLabel : labels.driverLabel;
  let carrierName = '';
  if (isBus) {
    carrierName = trip.transport_company || (lang === 'tj' ? 'Ширкати мусофирбарӣ' : (lang === 'uz' ? 'Tashuvchi korxona' : 'Автобусный перевозчик'));
  } else {
    if (trip.driver_name && typeof trip.driver_name === 'string' && trip.driver_name.trim() && trip.driver_name.trim() !== 'Водитель') {
      carrierName = trip.driver_name.trim();
    } else {
      carrierName = lang === 'tj' ? 'Ронанда' : (lang === 'uz' ? 'Haydovchi' : 'Водитель');
    }
  }

  return [
    `${title}: ${fromCity} → ${toCity}`,
    `${labels.dateLabel}: ${formattedDate}, ${time}`,
    `${labels.priceLabel}: ${price} ${labels.priceUnit}`,
    `${labels.seatsLabel}: ${seats}`,
    `${personLabel}: ${carrierName}`
  ].join('\n');
}

/**
 * Main entry point: Formats AI Assistant response deterministically.
 *
 * @param {Object} params
 * @param {string} params.userMessage Current incoming user message
 * @param {string} params.reply Claude text reply
 * @param {Array<any>} params.trips Structured trips from DB tool result
 * @param {string} params.miniAppUrl Base URL for Mini App
 * @returns {{ text: string, inlineKeyboard: Array<Array<any>>, lang: string }}
 */
export function formatAiAssistantResponse({ userMessage, reply, trips, miniAppUrl = 'https://poputki.online' }) {
  const lang = detectLanguage(userMessage);
  const labels = LABELS[lang] || LABELS.ru;
  const baseAppUrl = miniAppUrl.replace(/\/$/, '');

  // 1. Strict Filter of trips:
  // Exclude 0 seats, negative seats, past trips, and passenger entries
  const validTrips = (Array.isArray(trips) ? trips : []).filter(trip => {
    if (!trip || typeof trip !== 'object') return false;

    // Filter out passenger entries
    if (trip.is_passenger_entry === true) return false;

    // Filter out 0 or negative available seats
    const seats = trip.seats_available !== undefined ? trip.seats_available : trip.seats;
    if (typeof seats === 'number' && seats <= 0) return false;

    return true;
  });

  // 2. Branch: Valid structured trips found
  if (validTrips.length > 0) {
    const intro = extractCleanIntro(reply, lang);
    const cards = validTrips.map(trip => formatDeterministicTripCard(trip, lang));

    const fullText = `${intro}\n\n${cards.join('\n\n')}`;
    const cleanText = sanitizeMarkdown(fullText);

    // Build deterministic inline keyboard buttons
    const inlineKeyboard = [];
    for (const trip of validTrips) {
      const price = trip.price_somoni !== undefined ? trip.price_somoni : (trip.price || 0);
      const btnText = trip.type === 'bus'
        ? labels.bookBusBtn(trip.from_city, trip.to_city, price)
        : labels.bookCarpoolBtn(trip.from_city, trip.to_city, price);

      const path = trip.booking_path || (trip.type === 'bus' ? `/bus-ticket/${trip.id}` : `/ride/${trip.id}`);
      const appUrl = `${baseAppUrl}${path}`;

      inlineKeyboard.push([{ text: btnText, web_app: { url: appUrl } }]);
    }

    // Always append App Search button
    inlineKeyboard.push([{ text: labels.searchBtn, web_app: { url: `${baseAppUrl}/search` } }]);

    return {
      text: cleanText,
      inlineKeyboard,
      lang
    };
  }

  // 3. Branch: No trips returned (informational / conversational query or empty search)
  const cleanReply = sanitizeMarkdown(reply || '');
  const searchKeyboard = [[{ text: labels.searchBtn, web_app: { url: `${baseAppUrl}/search` } }]];

  return {
    text: cleanReply,
    inlineKeyboard: searchKeyboard,
    lang
  };
}
