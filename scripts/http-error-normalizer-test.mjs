import assert from 'node:assert/strict';
import { normalizeHttpClientError } from '../src/core/errors.js';

assert.deepEqual(
  normalizeHttpClientError({ statusCode: 415, code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', message: 'internal framework text' }),
  { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type' },
);
assert.deepEqual(
  normalizeHttpClientError({ statusCode: 400, code: 'FST_ERR_CTP_INVALID_JSON_BODY' }),
  { statusCode: 400, code: 'INVALID_JSON', message: 'Request body contains invalid JSON' },
);
assert.deepEqual(
  normalizeHttpClientError({ statusCode: 429, code: 'SOME_RATE_LIMIT_PLUGIN_CODE' }),
  { statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests' },
);
assert.deepEqual(
  normalizeHttpClientError({ statusCode: 418, code: 'SOME_CLIENT_ERROR' }),
  { statusCode: 418, code: 'HTTP_418', message: 'Request failed' },
);
assert.equal(normalizeHttpClientError({ statusCode: 500, code: 'BOOM' }), null);
assert.equal(normalizeHttpClientError(new Error('no status')), null);

console.log('PASS HTTP client-error normalization preserves safe 4xx semantics');
console.log('PASS framework messages are replaced by stable public error text');
console.log('PASS 5xx/unclassified errors remain on the internal-error path');
