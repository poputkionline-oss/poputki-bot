import { resolveGeoCity } from './geoCityResolver.js';

export const locationKeyboard = {
  keyboard: [[{ text: '📍 Передать геолокацию', request_location: true }]],
  resize_keyboard: true,
  one_time_keyboard: true
};

// No coordinates, Telegram identity or location history are persisted or logged.
export async function handleGeolocation(message, { backendApiUrl, miniAppUrl, sendMessage, fetchImpl = fetch }) {
  let city = null;
  try {
    const response = await fetchImpl(`${backendApiUrl}/general/cities?type=bus`,
      { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const available = await response.json();
      if (Array.isArray(available)) city = resolveGeoCity(message.location.latitude,
        message.location.longitude, available, message.location.horizontal_accuracy);
    }
  } catch { /* Always allow manual search when city lookup is unavailable. */ }
  const url = new URL('/search', miniAppUrl);
  url.searchParams.set('tab', 'bus');
  if (city) url.searchParams.set('from', city);
  await sendMessage({
    chat_id: message.chat.id,
    text: city ? `📍 Ближайший город отправления: ${city}.\nОткройте поиск и выберите, куда поедете. Город отправления можно изменить.\n\nДанные городов: GeoNames.org.`
      : 'Не удалось найти город отправления рядом с Вами. Откройте поиск и выберите город вручную.',
    reply_markup: { inline_keyboard: [[{ text: '🚌 Найти билет на автобус', web_app: { url: url.href } }]] }
  });
}
