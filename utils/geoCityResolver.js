// GeoNames attribution and dataset limits: geoCities.LICENSE.md.
import cities from './geoCities.json' with { type: 'json' };

const normalize = value => String(value).replace(/\s*\((?:[A-Z]{2}|РФ)\)\s*$/i, '').normalize('NFKC').toLowerCase()
  .replace(/ё/g, 'е').replace(/[\s\-’']/g, '');
const radians = value => value * Math.PI / 180;
export function distanceKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin(radians(lat2 - lat1) / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(radians(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

// Only suggest a service city within 25 km and in the nearest city's country.
// A distant supported departure must never silently replace the actual location.
export function resolveGeoCity(latitude, longitude, availableCities, accuracy = 0) {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90
      || !Number.isFinite(longitude) || Math.abs(longitude) > 180
      || (Number.isFinite(accuracy) && accuracy > 10000)) return null;
  const available = new Map();
  for (const name of availableCities) {
    const key = normalize(name);
    const countryCode = String(name).match(/\(([A-Z]{2}|РФ)\)\s*$/i)?.[1]?.toUpperCase();
    const country = countryCode === 'РФ' ? 'RU' : countryCode;
    if (!available.has(key)) available.set(key, []);
    available.get(key).push({ name, country });
  }
  let nearest = null;
  let supported = [];
  for (const [lat, lon, country, names] of cities) {
    const distance = distanceKm(latitude, longitude, lat, lon);
    if (!nearest || distance < nearest.distance) nearest = { country, distance };
    if (distance > 25) continue;
    const name = names.map(normalize).flatMap(n => available.get(n) || [])
      .find(item => !item.country || item.country === country)?.name;
    if (name) supported.push({ city: name, country, distance });
  }
  return supported.filter(item => item.country === nearest?.country)
    .sort((a, b) => a.distance - b.distance)[0]?.city || null;
}
