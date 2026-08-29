import assert from 'node:assert/strict';
import {
  tokenPayEncryptSignature,
  tokenPayResponsePlaintext,
  tokenPayResponseSignatureDiagnostic,
  verifyTokenPayResponse,
} from '../src/modules/payments/providers/tokenpay.js';

const secret='12345678901234567890123456789012';
const timestamp='1787993000123';
const nonce='00112233445566778899aabbccddeeff';

const parsed={
  code:0,
  msg:'ok',
  request_id:'9b9e08ab-48e5-4efa-83e7-97e5e3fe3d0c',
  data:{
    prepay_id:'15809074c5bbc36bce27e0000000000000000000a4ca0a281d7e1260624a1c2',
    payment_url:'/pay/order?prepay_id=15809074c5bbc36bce27e0000000000000000000a4ca0a281d7e1260624a1c2',
  },
};
const raw=JSON.stringify(parsed,null,2);
const dataBody=JSON.stringify(parsed.data);
const signature=tokenPayEncryptSignature(tokenPayResponsePlaintext({timestamp,nonce,body:dataBody}),secret);

const verification=verifyTokenPayResponse({timestamp,nonce,rawBody:raw,signature,appSecret:secret});
assert.equal(verification.ok,true);
assert.equal(verification.mode,'DATA_JSON');
assert.equal(verification.dataBody,dataBody);
assert.equal(verification.canonicalBody,JSON.stringify(parsed));

const invalid=verifyTokenPayResponse({timestamp,nonce,rawBody:raw,signature:'invalid',appSecret:secret});
assert.equal(invalid.ok,false);
assert.equal(invalid.mode,null);
assert.equal(invalid.dataBody,dataBody);

const response={status:200,headers:{entries:()=>[['content-type','application/json'],['ttpay-signature',signature]][Symbol.iterator]()}};
const diagnostic=tokenPayResponseSignatureDiagnostic({
  response,timestamp,nonce,body:raw,signature,appSecret:secret,
  canonicalBody:invalid.canonicalBody,dataBody:invalid.dataBody,
});
assert.equal(diagnostic.data_body_bytes,Buffer.byteLength(dataBody));
assert.equal(diagnostic.data_body_sha256.length,64);
assert.equal(diagnostic.data_expected_signature_sha256.length,64);
const serialized=JSON.stringify(diagnostic);
assert.doesNotMatch(serialized,/12345678901234567890123456789012|prepay_id|not-the-real-signature/);

console.log('PASS TokenPay response data-object signature compatibility remains cryptographically strict');
