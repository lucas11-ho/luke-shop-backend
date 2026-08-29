import { errors } from '../../core/errors.js';

const POLICIES = Object.freeze({
  PHYSICAL: { label:'Physical product', modes:['SHIPPING','LOCAL_DELIVERY','PICKUP'], defaultModes:['SHIPPING'] },
  FOOD: { label:'Prepared food', modes:['LOCAL_DELIVERY','PICKUP'], defaultModes:['LOCAL_DELIVERY'] },
  DIGITAL_IMAGE: { label:'Digital image', modes:['DIGITAL_ACCESS','DIGITAL_DOWNLOAD'], defaultModes:['DIGITAL_ACCESS'] },
  DIGITAL_VIDEO: { label:'Digital video', modes:['DIGITAL_ACCESS','DIGITAL_DOWNLOAD'], defaultModes:['DIGITAL_ACCESS'] },
  SERVICE: { label:'Service', modes:['NONE'], defaultModes:['NONE'] },
});

export function productFulfillmentPolicy(productType) {
  const policy=POLICIES[productType];
  if(!policy) throw errors.badRequest('PRODUCT_TYPE_INVALID','Invalid product type');
  return { product_type:productType, ...policy };
}

export function allowedFulfillmentModesForProductType(productType){
  return [...productFulfillmentPolicy(productType).modes];
}

export function defaultFulfillmentModesForProductType(productType){
  return [...productFulfillmentPolicy(productType).defaultModes];
}

export function assertProductFulfillmentCompatibility(productType,modes){
  const policy=productFulfillmentPolicy(productType);
  const values=[...new Set(Array.isArray(modes)?modes:[])];
  if(!values.length) throw errors.badRequest('FULFILLMENT_REQUIRED','At least one fulfillment mode is required');
  const invalid=values.filter(mode=>!policy.modes.includes(mode));
  if(invalid.length){
    throw errors.badRequest('PRODUCT_FULFILLMENT_INCOMPATIBLE',`${policy.label} cannot use ${invalid.join(', ')}`,{
      product_type:productType, allowed_fulfillment_modes:policy.modes, invalid_fulfillment_modes:invalid,
    });
  }
  return values;
}

export function isDigitalProductType(productType){
  return productType==='DIGITAL_IMAGE'||productType==='DIGITAL_VIDEO';
}
