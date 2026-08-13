import assert from 'node:assert/strict';
import { assertOrderTransition, makeOrderNumber, orderTypeFor, paymentStatusFor } from '../src/modules/orders/service.js';

assert.equal(orderTypeFor(['PHYSICAL']), 'PHYSICAL');
assert.equal(orderTypeFor(['FOOD']), 'FOOD');
assert.equal(orderTypeFor(['DIGITAL_IMAGE']), 'DIGITAL');
assert.equal(orderTypeFor(['DIGITAL_VIDEO']), 'DIGITAL');
assert.equal(orderTypeFor(['SERVICE']), 'SERVICE');
assert.equal(orderTypeFor(['PHYSICAL','DIGITAL_IMAGE']), 'MIXED');
assert.doesNotThrow(() => assertOrderTransition('PHYSICAL','PENDING_PAYMENT','PAID'));
assert.doesNotThrow(() => assertOrderTransition('FOOD','PAID','RESTAURANT_ACCEPTED'));
assert.doesNotThrow(() => assertOrderTransition('DIGITAL','PAID','ACCESS_GRANTED'));
assert.throws(() => assertOrderTransition('DIGITAL','PAID','SHIPPED'), /cannot transition/);
assert.equal(paymentStatusFor('PAID','PENDING'),'PAID');
assert.equal(paymentStatusFor('REFUND_PENDING','PAID'),'REFUND_PENDING');
assert.match(makeOrderNumber(new Date('2026-08-11T12:34:56Z')), /^LS20260811123456[A-F0-9]{8}$/);
console.log('PASS order type classifier and physical/food/digital/service state machines');
console.log('PASS payment status projection and collision-resistant order number format');
