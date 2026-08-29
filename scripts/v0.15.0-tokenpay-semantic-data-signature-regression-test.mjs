import assert from 'node:assert/strict';
import { tokenPayEncryptSignature } from '../src/modules/payments/providers/tokenpay.js';
import { verifyTokenPayReplySignature } from '../src/modules/payments/providers/tokenpay-prepayment-live.js';

const secret='12345678901234567890123456789012';
const timestamp='1787993000123';
const nonce='00112233445566778899aabbccddeeff';
const raw='{"code":0,"msg":"ok","request_id":"rid_semantic","data":{"prepay_id":"pre_semantic","payment_url":"/pay/order?prepay_id=pre_semantic"}}';

// Same JSON object as response.data, but TokenPay signs it in the opposite key order.
const reordered='{"payment_url":"/pay/order?prepay_id=pre_semantic","prepay_id":"pre_semantic"}';
const signature=tokenPayEncryptSignature(`${timestamp}\n${nonce}\n${reordered}`,secret);
const verified=verifyTokenPayReplySignature({
  rawBody:raw,
  signature,
  appSecret:secret,
  responseTimestamp:timestamp,
  responseNonce:nonce,
  requestTimestamp:'1787992999000',
  requestNonce:'ffeeddccbbaa99887766554433221100',
});
assert.equal(verified.ok,true);
assert.equal(verified.mode,'DECRYPT_RESPONSE_TNB_SEMANTIC_DATA');
assert.equal(verified.semanticDataMatch,true);

// A cryptographically valid signature over different payment data must still be rejected.
const changed='{"payment_url":"/pay/order?prepay_id=pre_semantic","prepay_id":"pre_changed"}';
const changedSignature=tokenPayEncryptSignature(`${timestamp}\n${nonce}\n${changed}`,secret);
const rejected=verifyTokenPayReplySignature({
  rawBody:raw,
  signature:changedSignature,
  appSecret:secret,
  responseTimestamp:timestamp,
  responseNonce:nonce,
  requestTimestamp:'1787992999000',
  requestNonce:'ffeeddccbbaa99887766554433221100',
});
assert.equal(rejected.ok,false);
assert.equal(rejected.semanticDataMatch,false);

console.log('PASS TokenPay semantic data signature verification ignores JSON key order but rejects changed payment data');
