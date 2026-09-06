import { normalizeThemeComponentOverrides, platformIconKeyFromThemeToken } from './service.js';
import { requirePublishedPlatformGlyphs } from '../icons/service.js';
import { requirePublishedCustomImageIcons } from '../icons/custom-image-policy.js';

const NAV_ICON_KEYS=Object.freeze(['nav_home_icon','nav_explore_icon','nav_cart_icon','nav_orders_icon','nav_profile_icon']);

export function customerNavigationSelections(componentOverrides={}){
  const normalized=normalizeThemeComponentOverrides(componentOverrides);
  return [...new Set(NAV_ICON_KEYS.map(key=>normalized[key]).filter(Boolean))];
}
export function customerNavigationGlyphs(componentOverrides={}){
  return customerNavigationSelections(componentOverrides).filter(value=>!platformIconKeyFromThemeToken(value));
}
export function customerNavigationPlatformIconKeys(componentOverrides={}){
  return [...new Set(customerNavigationSelections(componentOverrides).map(platformIconKeyFromThemeToken).filter(Boolean))];
}

export async function validateCustomerNavigationIconPolicy(db,componentOverrides={},{strict=true}={}){
  if(!strict)return[];
  const glyphs=customerNavigationGlyphs(componentOverrides);
  const customKeys=customerNavigationPlatformIconKeys(componentOverrides);
  if(glyphs.length)await requirePublishedPlatformGlyphs(db,{
    scope:'NAVIGATION',
    libraryPack:'PHOSPHOR',
    glyphs,
    errorCode:'THEME_NAV_ICON_PLATFORM_NOT_ALLOWED',
  });
  if(customKeys.length)await requirePublishedCustomImageIcons(db,{
    scope:'NAVIGATION',
    keys:customKeys,
    errorCode:'THEME_NAV_ICON_PLATFORM_NOT_ALLOWED',
  });
  return [...glyphs,...customKeys];
}

export async function validateCustomerExperienceIconPolicy(db,config={},{strict=true}={}){
  return validateCustomerNavigationIconPolicy(db,config?.theme_component_overrides||{},{strict});
}
