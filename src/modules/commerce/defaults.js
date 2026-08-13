import { publicId, uuid } from '../../core/identifiers.js';

const DEFAULT_PAYMENT_METHODS = [
  {
    code: 'MANUAL',
    name: 'Manual Payment',
    providerType: 'MANUAL',
    instructions: 'Merchant confirms payment manually.',
    sortOrder: 0,
  },
];

const DEFAULT_DELIVERY_METHODS = [
  { code: 'PICKUP', name: 'Store Pickup', fulfillmentMode: 'PICKUP', flatFee: 0, sortOrder: 0 },
  { code: 'SHIPPING', name: 'Standard Shipping', fulfillmentMode: 'SHIPPING', flatFee: 0, sortOrder: 10 },
  { code: 'LOCAL', name: 'Local Delivery', fulfillmentMode: 'LOCAL_DELIVERY', flatFee: 0, sortOrder: 20 },
];

export async function ensureStoreCommerceDefaults(client, { tenantId, storeId }) {
  for (const method of DEFAULT_PAYMENT_METHODS) {
    await client.query(
      `INSERT INTO payment_methods(
         id,public_id,tenant_id,store_id,code,name,provider_type,status,instructions,sort_order
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,$9)
       ON CONFLICT (tenant_id,store_id,code) DO NOTHING`,
      [uuid(), publicId('paym'), tenantId, storeId, method.code, method.name, method.providerType, method.instructions, method.sortOrder],
    );
  }

  for (const method of DEFAULT_DELIVERY_METHODS) {
    await client.query(
      `INSERT INTO delivery_methods(
         id,public_id,tenant_id,store_id,code,name,fulfillment_mode,status,flat_fee,min_order,sort_order
       ) VALUES($1,$2,$3,$4,$5,$6,$7,'ACTIVE',$8,0,$9)
       ON CONFLICT (tenant_id,store_id,code) DO NOTHING`,
      [uuid(), publicId('dlv'), tenantId, storeId, method.code, method.name, method.fulfillmentMode, method.flatFee, method.sortOrder],
    );
  }

  const [payments, deliveries] = await Promise.all([
    client.query(
      `SELECT code,name,provider_type,status,sort_order
         FROM payment_methods
        WHERE tenant_id=$1 AND store_id=$2 AND code='MANUAL'`,
      [tenantId, storeId],
    ),
    client.query(
      `SELECT code,name,fulfillment_mode,status,flat_fee,min_order,sort_order
         FROM delivery_methods
        WHERE tenant_id=$1 AND store_id=$2 AND code = ANY($3::text[])
        ORDER BY sort_order,code`,
      [tenantId, storeId, DEFAULT_DELIVERY_METHODS.map((row) => row.code)],
    ),
  ]);

  return { paymentMethods: payments.rows, deliveryMethods: deliveries.rows };
}
