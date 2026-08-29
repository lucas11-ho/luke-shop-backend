import { createCustomerPaymentSession } from './gateway-service.js';

export async function customerPaymentGatewayRoutes(app){
  app.post('/v1/customer/orders/:orderRef/payment/session',{preHandler:[app.requireCustomerAuth],config:{rateLimit:{max:20,timeWindow:'1 minute'}},schema:{body:{type:'object',additionalProperties:false,required:['idempotency_key'],properties:{idempotency_key:{type:'string',minLength:8,maxLength:160}}}}},async request=>{
    const session=await createCustomerPaymentSession(app,{tenantId:request.auth.tenantId,customerId:request.auth.actorId,orderRef:request.params.orderRef,idempotencyKey:request.body.idempotency_key});
    return {data:{payment_session:session}};
  });
}
