import { listPlatformIcons } from './service.js';

export async function merchantIconRoutes(app){
  app.get('/v1/merchant/icon-library',{preHandler:[app.requireMerchantAuth]},async request=>({
    data:{icons:await listPlatformIcons(app.db,{status:'PUBLISHED',scope:request.query?.scope||null})},
  }));
}
