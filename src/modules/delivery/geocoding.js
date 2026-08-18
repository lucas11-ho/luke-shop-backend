import { errors } from '../../core/errors.js';

function googleComponent(components, type, short = false) {
  const item = components.find((entry) => Array.isArray(entry.types) && entry.types.includes(type));
  return item ? (short ? item.short_name : item.long_name) : null;
}

function normalizeGoogleResult(result) {
  const components = Array.isArray(result?.address_components) ? result.address_components : [];
  const streetNumber = googleComponent(components, 'street_number');
  const route = googleComponent(components, 'route');
  const premise = googleComponent(components, 'premise');
  const subpremise = googleComponent(components, 'subpremise');
  const neighborhood = googleComponent(components, 'sublocality_level_1') || googleComponent(components, 'neighborhood');
  const city = googleComponent(components, 'locality') || googleComponent(components, 'postal_town') || googleComponent(components, 'administrative_area_level_2') || '';
  const state = googleComponent(components, 'administrative_area_level_1');
  const postalCode = googleComponent(components, 'postal_code');
  const countryCode = googleComponent(components, 'country', true);
  const line1 = [streetNumber, route].filter(Boolean).join(' ') || premise || neighborhood || '';
  const line2 = [subpremise, premise && premise !== line1 ? premise : null, neighborhood && neighborhood !== line1 ? neighborhood : null].filter(Boolean).join(', ') || null;
  return {
    formatted_address: result?.formatted_address || null,
    address_line_1: line1,
    address_line_2: line2,
    city,
    state: state || null,
    postal_code: postalCode || null,
    country_code: String(countryCode || '').toUpperCase() || null,
  };
}

async function googleReverse(config, latitude, longitude, acceptLanguage = '') {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('latlng', `${latitude},${longitude}`);
  url.searchParams.set('key', config.googleGeocodingApiKey);
  if (acceptLanguage) url.searchParams.set('language', acceptLanguage.split(',')[0].trim().slice(0, 16));
  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw errors.unavailable('GEOCODING_UNAVAILABLE', 'Address lookup provider is unavailable');
  }
  if (!response.ok) throw errors.unavailable('GEOCODING_UNAVAILABLE', 'Address lookup provider returned an error');
  const json = await response.json();
  if (json.status === 'ZERO_RESULTS') throw errors.notFound('GEOCODING_NO_RESULT', 'No readable address was found for this location');
  if (json.status !== 'OK' || !json.results?.length) throw errors.unavailable('GEOCODING_UNAVAILABLE', 'Address lookup provider returned an error');
  return normalizeGoogleResult(json.results[0]);
}

async function nominatimReverse(config, latitude, longitude) {
  const url = new URL(`${config.geocodingBaseUrl}/reverse`);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('addressdetails', '1');
  url.searchParams.set('lat', String(latitude));
  url.searchParams.set('lon', String(longitude));
  let response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'LukeShop/0.14 delivery-address' } });
  } catch {
    throw errors.unavailable('GEOCODING_UNAVAILABLE', 'Address lookup provider is unavailable');
  }
  if (!response.ok) throw errors.unavailable('GEOCODING_UNAVAILABLE', 'Address lookup provider returned an error');
  const json = await response.json();
  const address = json.address || {};
  return {
    formatted_address: json.display_name || null,
    address_line_1: [address.house_number, address.road || address.pedestrian || address.residential].filter(Boolean).join(' ') || address.neighbourhood || address.suburb || '',
    address_line_2: address.neighbourhood || address.suburb || null,
    city: address.city || address.town || address.village || address.municipality || '',
    state: address.state || address.region || null,
    postal_code: address.postcode || null,
    country_code: String(address.country_code || '').toUpperCase() || null,
  };
}

export async function reverseGeocode(config, latitude, longitude, acceptLanguage = '') {
  if (config.geocodingProvider === 'GOOGLE') return googleReverse(config, latitude, longitude, acceptLanguage);
  if (config.geocodingProvider === 'NOMINATIM') return nominatimReverse(config, latitude, longitude);
  throw errors.unavailable('GEOCODING_NOT_CONFIGURED', 'Address lookup is not configured');
}

export function customerMapConfig(config) {
  const enabled = config.geocodingProvider === 'GOOGLE' && Boolean(config.googleMapsBrowserApiKey);
  return {
    enabled,
    provider: enabled ? 'GOOGLE' : config.geocodingProvider,
    api_key: enabled ? config.googleMapsBrowserApiKey : null,
    map_id: enabled ? (config.googleMapsMapId || null) : null,
    search_enabled: enabled,
  };
}
