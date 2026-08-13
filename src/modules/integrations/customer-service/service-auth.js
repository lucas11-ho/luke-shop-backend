import { errors } from '../../../core/errors.js';
import { hashServiceSecret, safeHashEqual, verifyServiceAccessToken } from '../../../core/tokens.js';
import { consumeFreshServiceNonce, resolveSupportContext } from './context.js';
import { getCustomerServicePolicy } from './policy.js';

function bearer(request) {
  const auth=request.headers.authorization;
  if(!auth?.startsWith('Bearer ')) throw errors.unauthorized('SERVICE_AUTH_REQUIRED','Service authentication required');
  const value=auth.slice(7).trim(); if(!value) throw errors.unauthorized('SERVICE_AUTH_INVALID','Invalid service authentication'); return value;
}

async function findActiveClient(app, tenantId, id) {
  return app.db.query(`SELECT c.id,c.tenant_id,c.name,c.client_id,c.secret_hash,c.scopes,c.status,c.usage_mode,t.public_id AS tenant_public_id,t.slug
    FROM integration_clients c JOIN tenants t ON t.id=c.tenant_id
    WHERE c.id=$1 AND c.tenant_id=$2 AND c.kind='LUKE_CS' AND c.status='ACTIVE' AND t.status='ACTIVE'`,[id,tenantId]);
}

export function customerServiceAuthPlugin(app) {
  app.decorateRequest('serviceAuth',null); app.decorateRequest('serviceRequest',null); app.decorateRequest('supportContext',null);
  app.decorate('requireCustomerServiceAuth',async function requireCustomerServiceAuth(request){
    const value=bearer(request); let row; let authMode='SIGNED_TOKEN';
    if(value.startsWith('lcs_')){
      authMode='CREDENTIAL'; const index=value.indexOf('.'); if(index<5) throw errors.unauthorized('SERVICE_AUTH_INVALID','Invalid service credential');
      const clientId=value.slice(0,index),secret=value.slice(index+1);
      const found=await app.db.query(`SELECT c.id,c.tenant_id,c.name,c.client_id,c.secret_hash,c.scopes,c.status,c.usage_mode,t.public_id AS tenant_public_id,t.slug FROM integration_clients c JOIN tenants t ON t.id=c.tenant_id WHERE c.client_id=$1 AND c.kind='LUKE_CS' AND c.status='ACTIVE' AND t.status='ACTIVE'`,[clientId]);
      if(!found.rowCount) throw errors.unauthorized('SERVICE_AUTH_INVALID','Invalid service credential'); row=found.rows[0];
      const supplied=hashServiceSecret(secret,app.config.serviceCredentialPepper); if(!safeHashEqual(supplied,row.secret_hash)) throw errors.unauthorized('SERVICE_AUTH_INVALID','Invalid service credential');
    } else {
      let payload; try{payload=await verifyServiceAccessToken(app.config,value);}catch{throw errors.unauthorized('SERVICE_TOKEN_INVALID','Invalid or expired signed service token');}
      const found=await findActiveClient(app,payload.tenant_id,payload.sub); if(!found.rowCount) throw errors.unauthorized('SERVICE_TOKEN_INVALID','Signed service token client is no longer active'); row=found.rows[0];
    }
    request.serviceAuth={clientId:row.id,clientPublicId:row.client_id,tenantId:row.tenant_id,tenantPublicId:row.tenant_public_id,tenantSlug:row.slug,name:row.name,scopes:row.scopes||[],usageMode:row.usage_mode||'STAFF',authMode};
    await app.db.query('UPDATE integration_clients SET last_used_at=now() WHERE tenant_id=$1 AND id=$2',[row.tenant_id,row.id]);
  });
  app.decorate('requireSignedCustomerServiceToken',async function requireSignedCustomerServiceToken(request){
    if(request.serviceAuth?.authMode!=='SIGNED_TOKEN') throw errors.unauthorized('SERVICE_SIGNED_TOKEN_REQUIRED','Short-lived signed service token required');
  });
  app.decorate('requireServiceScope',function requireServiceScope(scope){return async function scopeGuard(request){
    if(request.serviceAuth?.usageMode==='AI') throw errors.forbidden('AI_TOOL_GATEWAY_REQUIRED','AI credentials must use the signed customer-context tool gateway');
    if(!request.serviceAuth?.scopes?.includes(scope)) throw errors.forbidden('SERVICE_SCOPE_REQUIRED',`Missing service scope: ${scope}`);
    const policy=await getCustomerServicePolicy(app.db,request.serviceAuth.tenantId); const generalMap={'customer.read':'customer_read','product.read':'product_read','orders.read':'orders_read','order_status.read':'orders_read','payments.read':'payments_read','delivery.read':'delivery_read'}; const aiMap={'customer.read':'ai_customer_read','product.read':'ai_product_read','orders.read':'ai_orders_read','order_status.read':'ai_orders_read','payments.read':'ai_payments_read','delivery.read':'ai_delivery_read'};
    if(!policy?.enabled||!policy[generalMap[scope]]||(request.serviceAuth.usageMode==='AI'&&!policy[aiMap[scope]])) throw errors.forbidden('CS_POLICY_DENIED','Tenant policy does not allow this customer service capability');
  };});
  app.decorate('requireFreshCustomerServiceRequest',async function(request){await consumeFreshServiceNonce(app,request);});
  app.decorate('requireCustomerServiceContext',async function(request){await resolveSupportContext(app,request);});
}
