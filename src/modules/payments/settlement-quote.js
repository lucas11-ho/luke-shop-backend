import { errors } from '../../core/errors.js';

const upper=value=>String(value||'').trim().toUpperCase();
const DECIMAL=/^\d+(?:\.\d+)?$/;

function decimalParts(value,label){
  const raw=String(value??'').trim();
  if(!DECIMAL.test(raw)) throw errors.conflict('PAYMENT_SETTLEMENT_RATE_INVALID',`${label} must be a positive decimal value`);
  const [whole,fraction='']=raw.split('.');
  return {integer:BigInt(`${whole}${fraction}`),scale:fraction.length,raw};
}

function tenPow(value){return 10n**BigInt(value);}

export function multiplyDecimalRoundUp(amount,rate,decimals=6){
  const left=decimalParts(amount,'Order amount'),right=decimalParts(rate,'Settlement rate');
  if(left.integer<0n||right.integer<=0n) throw errors.conflict('PAYMENT_SETTLEMENT_RATE_INVALID','Settlement amount and rate must be positive');
  const places=Math.max(0,Math.min(8,Math.trunc(Number(decimals)||0)));
  const product=left.integer*right.integer;
  const productScale=left.scale+right.scale;
  let scaled;
  if(productScale<=places){
    scaled=product*tenPow(places-productScale);
  }else{
    const divisor=tenPow(productScale-places);
    scaled=product/divisor;
    if(product%divisor!==0n) scaled+=1n;
  }
  const text=scaled.toString().padStart(places+1,'0');
  if(!places)return text;
  const whole=text.slice(0,-places)||'0';
  const fraction=text.slice(-places).replace(/0+$/,'');
  return fraction?`${whole}.${fraction}`:whole;
}

export function resolveSettlementQuote({order,providerCurrency,settlementPolicy,now=new Date()}){
  const sourceCurrency=upper(order?.currency),targetCurrency=upper(providerCurrency);
  const sourceAmount=String(order?.grand_total??'').trim();
  if(!sourceCurrency||!targetCurrency) throw errors.conflict('PAYMENT_SETTLEMENT_CONFIG_INVALID','Order and settlement currencies are required');
  if(!DECIMAL.test(sourceAmount)) throw errors.conflict('PAYMENT_SETTLEMENT_AMOUNT_INVALID','Order amount is invalid');
  if(sourceCurrency===targetCurrency){
    return {mode:'EXACT',rate_source:'EXACT_CURRENCY',source_currency:sourceCurrency,source_amount:Number(sourceAmount),target_currency:targetCurrency,target_amount:Number(sourceAmount),rate:'1',rounding:'NONE',decimals:4,quoted_at:now.toISOString()};
  }
  const policy=settlementPolicy&&typeof settlementPolicy==='object'?settlementPolicy:{};
  const mode=upper(policy.mode);
  if(mode!=='MANUAL_RATE') throw errors.conflict('PAYMENT_SETTLEMENT_RATE_REQUIRED',`TokenPay settles in ${targetCurrency} while the order is ${sourceCurrency}; configure an explicit settlement rate before payment`);
  const configuredSource=upper(policy.source_currency);
  if(configuredSource!==sourceCurrency) throw errors.conflict('PAYMENT_SETTLEMENT_SOURCE_CURRENCY_MISMATCH',`TokenPay settlement rate is configured for ${configuredSource||'another currency'}, not ${sourceCurrency}`);
  const rate=String(policy.rate??'').trim();
  const rateParts=decimalParts(rate,'Settlement rate');
  if(rateParts.integer<=0n) throw errors.conflict('PAYMENT_SETTLEMENT_RATE_INVALID','Settlement rate must be greater than zero');
  const decimals=Math.max(2,Math.min(8,Math.trunc(Number(policy.decimals)||6)));
  const targetAmount=multiplyDecimalRoundUp(sourceAmount,rate,decimals);
  return {mode:'MANUAL_RATE',rate_source:'MERCHANT_CONFIGURED',source_currency:sourceCurrency,source_amount:Number(sourceAmount),target_currency:targetCurrency,target_amount:Number(targetAmount),rate,rounding:'UP',decimals,quoted_at:now.toISOString()};
}
