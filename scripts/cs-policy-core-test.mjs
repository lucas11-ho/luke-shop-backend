import assert from 'node:assert/strict';
import { CS_TOOL_NAMES, contextAllowedTools, isToolAllowed, toolsAllowedByPolicy } from '../src/modules/integrations/customer-service/policy.js';

const base={enabled:true,customer_read:true,product_read:true,orders_read:true,payments_read:true,delivery_read:true,ai_customer_read:false,ai_product_read:true,ai_orders_read:false,ai_payments_read:false,ai_delivery_read:true};
assert.equal(CS_TOOL_NAMES.length,8);
assert.equal(isToolAllowed(base,'STAFF','customer.get'),true);
assert.equal(isToolAllowed(base,'AI','customer.get'),false);
assert.equal(isToolAllowed(base,'AI','product.search'),true);
assert.equal(isToolAllowed(base,'AI','order.status'),false);
assert.equal(isToolAllowed(base,'AI','delivery.status'),true);
assert.equal(contextAllowedTools(base).includes('payment.status'),true);
assert.equal(toolsAllowedByPolicy({...base,enabled:false},'STAFF').length,0);
assert.equal(CS_TOOL_NAMES.some((tool)=>/(cancel|refund|change|update|delete|create)/.test(tool)),false);
console.log('PASS Luke CS policy/tool allowlist core');
