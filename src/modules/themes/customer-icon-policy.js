import { normalizeThemeComponentOverrides } from './service.js';
import { requirePublishedPlatformGlyphs } from '../icons/service.js';

const NAV_ICON_KEYS=Object.freeze(['nav_home_icon','nav_explore_icon','nav_cart_icon','nav_orders_icon','nav_profile_icon']);

export function customerNavigationGlyphs(componentOverrides={}){
  const normalized=normalizeThemeComponentOverrides(componentOverrides);
  return [...new Set(NAV_ICON_KEYS.map(key=>normalized[key]).filter(Boolean))];
}

export async function validateCustomerNavigationIconPolicy(db,componentOverrides={},{strict=true}={}){
  if(!strict)return[];
  const glyphs=customerNavigationGlyphs(componentOverrides);
  if(!glyphs.length)return[];
  return requirePublishedPlatformGlyphs(db,{
    scope:'NAVIGATION',
    libraryPack:'PHOSPHOR',
    glyphs,
    errorCode:'THEME_NAV_ICON_PLATFORM_NOT_ALLOWED',
  });
}

export async function validateCustomerExperienceIconPolicy(db,config={},{strict=true}={}){
  return validateCustomerNavigationIconPolicy(db,config?.theme_component_overrides||{},{strict});
}
