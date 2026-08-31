import { errors } from '../../core/errors.js';

export const DELIVERY_STORE_DEFAULTS=Object.freeze({
 delivery_enabled:true,
 enforce_operating_hours:false,
 operating_hours:{mon:[{open:'00:00',close:'23:59'}],tue:[{open:'00:00',close:'23:59'}],wed:[{open:'00:00',close:'23:59'}],thu:[{open:'00:00',close:'23:59'}],fri:[{open:'00:00',close:'23:59'}],sat:[{open:'00:00',close:'23:59'}],sun:[{open:'00:00',close:'23:59'}]},
 same_day_cutoff_local:null,
 default_prep_minutes:20,
 require_ready_before_dispatch:false,
 kitchen_enabled:true,
 cashier_enabled:true,
 kitchen_payment_policy:'PAID_OR_COD',
 temporary_closure_message:null,
});

const DAY_KEYS=['mon','tue','wed','thu','fri','sat','sun'];
const TIME_RE=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const normalizeTime=value=>String(value||'').slice(0,5);

export function normalizeOperatingHours(input){
 const value=input&&typeof input==='object'&&!Array.isArray(input)?input:{};const out={};
 for(const day of DAY_KEYS){
  const windows=Array.isArray(value[day])?value[day]:[];
  out[day]=windows.map((window,index)=>{
   const open=String(window?.open||'').trim(),close=String(window?.close||'').trim();
   if(!TIME_RE.test(open)||!TIME_RE.test(close))throw errors.badRequest('DELIVERY_OPERATING_HOURS_INVALID',`Invalid ${day} operating window at position ${index+1}`);
   if(open>close)throw errors.badRequest('DELIVERY_OPERATING_HOURS_INVALID','Overnight operating windows are not supported in this release; split the schedule across two days');
   return {open,close};
  });
 }
 return out;
}

export async function readDeliveryStoreSettings(db,tenantId,storeId){
 const result=await db.query(`SELECT delivery_enabled,enforce_operating_hours,operating_hours,same_day_cutoff_local,default_prep_minutes,require_ready_before_dispatch,kitchen_enabled,cashier_enabled,kitchen_payment_policy,temporary_closure_message,created_at,updated_at FROM delivery_store_settings WHERE tenant_id=$1 AND store_id=$2`,[tenantId,storeId]);
 if(!result.rowCount)return {...DELIVERY_STORE_DEFAULTS,configured:false,created_at:null,updated_at:null};
 const row=result.rows[0];return {...row,operating_hours:normalizeOperatingHours(row.operating_hours),same_day_cutoff_local:row.same_day_cutoff_local?normalizeTime(row.same_day_cutoff_local):null,configured:true};
}

export async function assertStoreFulfillmentWindow(db,{tenantId,storeId}){
 const settings=await readDeliveryStoreSettings(db,tenantId,storeId);
 if(!settings.delivery_enabled)throw errors.conflict('DELIVERY_STORE_DISABLED',settings.temporary_closure_message||'Delivery and pickup ordering is temporarily unavailable');
 if(!settings.enforce_operating_hours&&!settings.same_day_cutoff_local)return settings;
 const local=await db.query(`SELECT lower(to_char(now() AT TIME ZONE timezone,'Dy')) AS day_key,to_char(now() AT TIME ZONE timezone,'HH24:MI') AS local_time,timezone FROM tenant_settings WHERE tenant_id=$1`,[tenantId]);
 const day=local.rows[0]?.day_key||'mon',time=local.rows[0]?.local_time||'00:00';
 if(settings.enforce_operating_hours){const windows=settings.operating_hours[day]||[];if(!windows.some(window=>time>=window.open&&time<=window.close))throw errors.conflict('DELIVERY_STORE_CLOSED',settings.temporary_closure_message||'The store is currently outside its delivery and pickup operating hours',{day,local_time:time,timezone:local.rows[0]?.timezone||null});}
 if(settings.same_day_cutoff_local&&time>settings.same_day_cutoff_local)throw errors.conflict('DELIVERY_CUTOFF_PASSED','The same-day delivery and pickup cutoff has passed',{cutoff:settings.same_day_cutoff_local,local_time:time,timezone:local.rows[0]?.timezone||null});
 return settings;
}
