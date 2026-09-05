import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  detectLanguage,
  formatDate,
  sanitizeMarkdown,
  extractCleanIntro,
  formatDeterministicTripCard,
  formatAiAssistantResponse
} from '../utils/aiResponseFormatter.js';

describe('PHASE AI DATA INTEGRITY HOTFIX — Response Formatter & Language Routing', () => {

  const controlRide1865 = {
    type: 'carpool',
    id: 1865,
    from_city: 'Душанбе',
    to_city: 'Худжанд',
    date: '2026-09-08',
    time: '13:00',
    price_somoni: 100,
    seats_available: 3,
    driver_name: 'Шахром',
    driver_rating: 5.0,
    booking_path: '/ride/1865'
  };

  it('1. Carrier and seat count match tool result completely (Ride 1865)', () => {
    const formatted = formatAiAssistantResponse({
      userMessage: 'Найди рейс из Душанбе в Худжанд на 8 сентября',
      reply: 'Нашёл для вас подходящий вариант:',
      trips: [controlRide1865],
      miniAppUrl: 'https://poputki.online'
    });

    assert.ok(formatted.text.includes('Душанбе → Худжанд'), 'Must include correct route');
    assert.ok(formatted.text.includes('8 сентября 2026, 13:00'), 'Must format date and time accurately');
    assert.ok(formatted.text.includes('100 сомони'), 'Must include price in somoni');
    assert.ok(formatted.text.includes('Свободных мест: 3'), 'Must strictly show 3 seats from tool result');
    assert.ok(formatted.text.includes('Водитель: Шахром'), 'Must strictly show driver Шахром from tool result');
    assert.strictEqual(formatted.lang, 'ru');
  });

  it('2. Claude cannot override structured fields with hallucinated values', () => {
    // Claude attempts to hallucinate 4 seats and "Ронанда" in reply text
    const hallucinatedReply = `Ёфтам! 🚗\n\n### 🟢 Попутка: Душанбе → Худҷанд\n\n📅 **Сана:** 8 сентябри 2026\n⏰ **Вақт:** 13:00\n💰 **Нарх:** 100 сомонӣ\n💺 **Ҷойҳои холӣ:** 4\n👤 **Ронанда:** Ронанда (рейтинг 5.0)`;

    const formatted = formatAiAssistantResponse({
      userMessage: 'Найди рейс из Душанбе в Худжанд на 8 сентября',
      reply: hallucinatedReply,
      trips: [controlRide1865],
      miniAppUrl: 'https://poputki.online'
    });

    // The rendered text must NOT contain Claude's hallucinated values
    assert.ok(!formatted.text.includes('Ҷойҳои холӣ: 4'), 'Must not display Claude hallucinated 4 seats');
    assert.ok(!formatted.text.includes('Ронанда: Ронанда'), 'Must not display Claude hallucinated carrier Ронанда');
    assert.ok(formatted.text.includes('Свободных мест: 3'), 'Must display verified DB seats (3)');
    assert.ok(formatted.text.includes('Водитель: Шахром'), 'Must display verified DB driver (Шахром)');
  });

  it('3. Language routing: Russian query receives Russian output', () => {
    const res = formatAiAssistantResponse({
      userMessage: 'Найди рейс из Душанбе в Худжанд на 8 сентября, пожалуйста',
      reply: 'Вот варианты:',
      trips: [controlRide1865],
      miniAppUrl: 'https://poputki.online'
    });

    assert.strictEqual(res.lang, 'ru');
    assert.ok(res.text.includes('🚗 Поездка: Душанбе → Худжанд'));
    assert.ok(res.text.includes('📅 Дата: 8 сентября 2026, 13:00'));
    assert.ok(res.text.includes('💰 Стоимость: 100 сомони'));
    assert.ok(res.text.includes('💺 Свободных мест: 3'));
    assert.ok(res.text.includes('👤 Водитель: Шахром'));
    assert.ok(res.inlineKeyboard[0][0].text.includes('🚗 Поездка Душанбе → Худжанд (100 с.)'));
  });

  it('4. Language routing: Tajik query receives Tajik output', () => {
    const res = formatAiAssistantResponse({
      userMessage: 'Аз Душанбе ба Хуҷанд сафар ҳаст барои 8 сентябр?',
      reply: 'Ёфтам!',
      trips: [controlRide1865],
      miniAppUrl: 'https://poputki.online'
    });

    assert.strictEqual(res.lang, 'tj');
    assert.ok(res.text.includes('🚗 Сафар: Душанбе → Худжанд'));
    assert.ok(res.text.includes('📅 Сана: 8 сентябри 2026, 13:00'));
    assert.ok(res.text.includes('💰 Арзиш: 100 сомонӣ'));
    assert.ok(res.text.includes('💺 Ҷойҳои холӣ: 3'));
    assert.ok(res.text.includes('👤 Ронанда: Шахром'));
    assert.ok(res.inlineKeyboard[0][0].text.includes('🚗 Сафар Душанбе → Худжанд (100 с.)'));
  });

  it('5. Language routing: Uzbek query receives Uzbek output', () => {
    const res = formatAiAssistantResponse({
      userMessage: 'Dushanbedan Xo\'jandga 8 sentabr reys bormi iltimos',
      reply: 'Topdim!',
      trips: [controlRide1865],
      miniAppUrl: 'https://poputki.online'
    });

    assert.strictEqual(res.lang, 'uz');
    assert.ok(res.text.includes('🚗 Safar: Душанбе → Худжанд'));
    assert.ok(res.text.includes('📅 Sana: 8 sentabr 2026, 13:00'));
    assert.ok(res.text.includes('💰 Narxi: 100 somoni'));
    assert.ok(res.text.includes('💺 Bo\'sh joylar: 3'));
    assert.ok(res.text.includes('👤 Haydovchi: Шахром'));
    assert.ok(res.inlineKeyboard[0][0].text.includes('🚗 Safar Душанбе → Худжанд (100 s.)'));
  });

  it('6. Raw Markdown markers (### and **) are completely stripped', () => {
    const messyReply = `### 🟢 Найдена поездка!\n\n**Важно:** Водитель выезжает **вовремя**.\n### Детали:\nЦена **100 сомони**.`;

    const res = formatAiAssistantResponse({
      userMessage: 'Расскажи о деталях поездки',
      reply: messyReply,
      trips: [], // Informational reply
      miniAppUrl: 'https://poputki.online'
    });

    assert.ok(!res.text.includes('###'), 'Must not contain ###');
    assert.ok(!res.text.includes('**'), 'Must not contain **');
    assert.ok(res.text.includes('Найдена поездка!'), 'Must preserve clean readable text');
    assert.ok(res.text.includes('Важно: Водитель выезжает вовремя.'), 'Must preserve content without raw asterisks');
  });

  it('7. Excludes rides without seats (seats_available <= 0)', () => {
    const fullRide = {
      type: 'carpool',
      id: 9991,
      from_city: 'Душанбе',
      to_city: 'Худжанд',
      date: '2026-09-08',
      time: '14:00',
      price_somoni: 100,
      seats_available: 0,
      driver_name: 'Али'
    };

    const res = formatAiAssistantResponse({
      userMessage: 'Найди рейс Душанбе Худжанд',
      reply: 'Рейсов со свободными местами не найдено.',
      trips: [fullRide],
      miniAppUrl: 'https://poputki.online'
    });

    // Ride with 0 seats must not be displayed in cards or keyboard
    assert.ok(!res.text.includes('Али'), 'Must not display full ride');
    assert.strictEqual(res.inlineKeyboard.length, 1, 'Only search button should be present');
    assert.ok(res.inlineKeyboard[0][0].web_app.url.endsWith('/search'));
  });

  it('8. Excludes passenger request entries (is_passenger_entry = true)', () => {
    const passengerEntry = {
      type: 'carpool',
      id: 9992,
      from_city: 'Душанбе',
      to_city: 'Худжанд',
      date: '2026-09-08',
      time: '15:00',
      price_somoni: 100,
      seats_available: 2,
      driver_name: 'Пассажир Заявка',
      is_passenger_entry: true
    };

    const res = formatAiAssistantResponse({
      userMessage: 'Найди рейс Душанбе Худжанд',
      reply: 'Рейсов не найдено',
      trips: [passengerEntry],
      miniAppUrl: 'https://poputki.online'
    });

    assert.ok(!res.text.includes('Пассажир Заявка'), 'Must not display passenger request');
    assert.strictEqual(res.inlineKeyboard.length, 1);
  });

  it('9. Deep link preserves correct ride_id (Ride 1865)', () => {
    const res = formatAiAssistantResponse({
      userMessage: 'Найди поездку Душанбе - Худжанд',
      reply: 'Вот рейс:',
      trips: [controlRide1865],
      miniAppUrl: 'https://www.poputki.online'
    });

    assert.strictEqual(res.inlineKeyboard[0][0].web_app.url, 'https://www.poputki.online/ride/1865');
    assert.strictEqual(res.inlineKeyboard[1][0].web_app.url, 'https://www.poputki.online/search');
  });

  it('10. Chat sessions history immunity: prior Tajik history does NOT invert Russian query', () => {
    // Simulated scenario from production pilot:
    // Prior session turns were in Tajik, but latest query is in Russian
    const currentQuery = 'Найди рейс из Душанбе в Худжанд на 8 сентября';

    const lang = detectLanguage(currentQuery);
    assert.strictEqual(lang, 'ru', 'Must detect Russian strictly from current message');

    const res = formatAiAssistantResponse({
      userMessage: currentQuery,
      reply: 'Ёфтам! 🚗', // Claude accidentally started in Tajik due to history
      trips: [controlRide1865],
      miniAppUrl: 'https://poputki.online'
    });

    assert.strictEqual(res.lang, 'ru', 'Final response language must remain Russian');
    assert.ok(res.text.includes('🚗 Поездка: Душанбе → Худжанд'), 'Card must be in Russian');
    assert.ok(res.text.includes('💺 Свободных мест: 3'), 'Seats label must be in Russian');
  });

  it('11. Bus tickets format carrier name and /bus-ticket/:id deep link properly', () => {
    const busTrip = {
      type: 'bus',
      id: 42,
      from_city: 'Душанбе',
      to_city: 'Москва',
      date: '2026-09-10',
      time: '08:00',
      price_somoni: 850,
      seats_available: 24,
      transport_company: 'Asian Express',
      booking_path: '/bus-ticket/42'
    };

    const res = formatAiAssistantResponse({
      userMessage: 'Автобус в Москву',
      reply: 'Вот автобусный рейс:',
      trips: [busTrip],
      miniAppUrl: 'https://poputki.online'
    });

    assert.ok(res.text.includes('🚌 Автобус: Душанбе → Москва'));
    assert.ok(res.text.includes('🏢 Перевозчик: Asian Express'));
    assert.ok(res.text.includes('💺 Свободных мест: 24'));
    assert.strictEqual(res.inlineKeyboard[0][0].web_app.url, 'https://poputki.online/bus-ticket/42');
  });

  it('12. Behavioral test on exact control ride 1865: 3 seats, Шахром, RU, no raw markdown, /ride/1865', () => {
    const rawRide1865 = {
      type: 'carpool',
      id: 1865,
      from_city: 'Душанбе',
      to_city: 'Худжанд',
      date: '2026-09-08',
      time: '13:00',
      price_somoni: 100,
      seats: 3,
      seats_available: 3,
      driver_name: 'Шахром',
      phone: '+992552421001',
      booking_path: '/ride/1865'
    };

    const res = formatAiAssistantResponse({
      userMessage: 'Найди рейс из Душанбе в Худжанд на 8 сентября',
      reply: '### 🟢 Вот найденный рейс:\n**Детали:** Отличная поездка!',
      trips: [rawRide1865],
      miniAppUrl: 'https://www.poputki.online'
    });

    // 1. Language must be RU
    assert.strictEqual(res.lang, 'ru');
    // 2. Exactly 3 available seats
    assert.ok(res.text.includes('💺 Свободных мест: 3'), 'Must show 3 seats');
    // 3. Driver must be Шахром
    assert.ok(res.text.includes('👤 Водитель: Шахром'), 'Must show Шахром');
    // 4. No raw Markdown headers (###) or bold (**)
    assert.ok(!res.text.includes('###'), 'Must not contain ###');
    assert.ok(!res.text.includes('**'), 'Must not contain **');
    // 5. Deep link strictly points to /ride/1865
    assert.strictEqual(res.inlineKeyboard[0][0].web_app.url, 'https://www.poputki.online/ride/1865');
  });

  it('13. Carrier name priority: valid name vs neutral localized fallback', () => {
    // A: Valid driver name
    const namedTrip = {
      type: 'carpool',
      id: 101,
      from_city: 'Душанбе',
      to_city: 'Худжанд',
      date: '2026-09-08',
      time: '10:00',
      seats_available: 2,
      driver_name: 'Шахром'
    };
    const resA = formatAiAssistantResponse({ userMessage: 'рейс', reply: '', trips: [namedTrip] });
    assert.ok(resA.text.includes('👤 Водитель: Шахром'));

    // B: Missing driver name in Russian
    const anonTripRu = {
      type: 'carpool',
      id: 102,
      from_city: 'Душанбе',
      to_city: 'Худжанд',
      date: '2026-09-08',
      time: '10:00',
      seats_available: 2,
      driver_name: ''
    };
    const resBRu = formatAiAssistantResponse({ userMessage: 'найди поездку', reply: '', trips: [anonTripRu] });
    assert.ok(resBRu.text.includes('👤 Водитель: Водитель'));

    // C: Missing driver name in Tajik
    const resBTj = formatAiAssistantResponse({ userMessage: 'аз душанбе ба хуҷанд сафар ҳаст', reply: '', trips: [anonTripRu] });
    assert.ok(resBTj.text.includes('👤 Ронанда: Ронанда'));

    // D: Missing driver name in Uzbek
    const resBUz = formatAiAssistantResponse({ userMessage: 'dushanbedan xo\'jandga reys bormi', reply: '', trips: [anonTripRu] });
    assert.ok(resBUz.text.includes('👤 Haydovchi: Haydovchi'));
  });

  it('14. Phone number from scraper_metadata is NEVER passed to Telegram text or buttons', () => {
    const tripWithPhone = {
      type: 'carpool',
      id: 1865,
      from_city: 'Душанбе',
      to_city: 'Худжанд',
      date: '2026-09-08',
      time: '13:00',
      price_somoni: 100,
      seats_available: 3,
      driver_name: 'Шахром',
      phone: '+992552421001',
      scraper_metadata: { phone: '+992552421001' }
    };

    const res = formatAiAssistantResponse({
      userMessage: 'найди рейс в Худжанд',
      reply: 'Вот рейс:',
      trips: [tripWithPhone],
      miniAppUrl: 'https://poputki.online'
    });

    assert.ok(!res.text.includes('+992552421001'), 'Phone must not appear in text');
    assert.ok(!res.text.includes('552421001'), 'Phone digits must not appear in text');
    assert.ok(!JSON.stringify(res.inlineKeyboard).includes('552421001'), 'Phone must not appear in buttons');
  });

  it('15. Seat boundaries: seats_available never exceeds seats and is never negative', () => {
    // Inconsistent input where seats_available is reported higher than seats
    const overflowTrip = {
      type: 'carpool',
      id: 105,
      from_city: 'Душанбе',
      to_city: 'Худжанд',
      date: '2026-09-08',
      time: '12:00',
      seats: 3,
      seats_available: 10,
      driver_name: 'Тест'
    };

    const res = formatAiAssistantResponse({
      userMessage: 'найди рейс',
      reply: '',
      trips: [overflowTrip],
      miniAppUrl: 'https://poputki.online'
    });

    assert.ok(res.text.includes('💺 Свободных мест: 3'), 'Available seats must be capped at seats=3');
    assert.ok(!res.text.includes('Свободных мест: 10'), 'Must not display overflow 10');
  });

});
