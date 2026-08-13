import assert from 'node:assert/strict';
import { assertFulfillmentTransition } from '../src/modules/delivery/service.js';
import { applyPromotionToTotals } from '../src/modules/promotions/service.js';

assert.doesNotThrow(()=>assertFulfillmentTransition('PENDING','PREPARING'));
assert.doesNotThrow(()=>assertFulfillmentTransition('SHIPPED','OUT_FOR_DELIVERY'));
assert.throws(()=>assertFulfillmentTransition('DELIVERED','SHIPPED'),/Fulfillment cannot transition/);
const percent=applyPromotionToTotals({promotionResult:{promotion:{promotion_type:'PERCENTAGE'},discount:12.5},deliveryTotal:6});
assert.equal(percent.discountTotal,12.5);assert.equal(percent.deliveryDiscount,0);
const free=applyPromotionToTotals({promotionResult:{promotion:{promotion_type:'FREE_DELIVERY'},discount:0},deliveryTotal:6});
assert.equal(free.discountTotal,0);assert.equal(free.deliveryDiscount,6);
console.log('PASS fulfillment state-machine core');
console.log('PASS promotion total application core');
