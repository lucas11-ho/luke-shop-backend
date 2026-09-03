import { publicId, uuid } from '../../core/identifiers.js';

export async function createZeroValueRewardSettlement(client,{tenantId,storeId,orderId,currency}){
  const paymentId=uuid();
  const result=await client.query(`INSERT INTO order_payments(id,public_id,tenant_id,store_id,order_id,payment_method_id,status,amount,currency,paid_at,metadata)
    VALUES($1,$2,$3,$4,$5,NULL,'PAID',0,$6,now(),$7::jsonb) RETURNING *`,[paymentId,publicId('pay'),tenantId,storeId,orderId,currency,JSON.stringify({settlement_type:'VIP_CASHBACK_FULL_COVERAGE'})]);
  await client.query(`INSERT INTO payment_attempts(id,public_id,tenant_id,store_id,payment_id,attempt_no,status,request_summary,completed_at)
    VALUES($1,$2,$3,$4,$5,1,'SUCCEEDED',$6::jsonb,now())`,[uuid(),publicId('pat'),tenantId,storeId,paymentId,JSON.stringify({settlement_type:'VIP_CASHBACK_FULL_COVERAGE',external_charge:false})]);
  return {...result.rows[0],method:null};
}
