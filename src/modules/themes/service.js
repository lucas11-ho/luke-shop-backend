import { errors } from '../../core/errors.js';

export const THEME_APPS = Object.freeze(['CUSTOMER_WEB','STAFF_WEB']);
export const THEME_STATUS = Object.freeze(['DRAFT','PUBLISHED','RETIRED']);
export const THEME_ICON_PACKS = Object.freeze({
  LUKE_OUTLINE:Object.freeze(['home','grid','bag','receipt','user']),
  PHOSPHOR_NAV:Object.freeze([
    'house','storefront','squares-four','shopping-bag','basket','handbag','receipt','clipboard-text','package','list-checks',
    'user-circle','user','heart','star','compass','magnifying-glass','tag','gift','bell','map-pin',
  ]),
});
export const THEME_TYPOGRAPHY_PRESETS = Object.freeze([
  'IOS_SYSTEM','SYSTEM_MINIMAL','MODERN_SANS','CLEAN_COMMERCE','GEOMETRIC','FRIENDLY',
  'HUMANIST','EDITORIAL','LUXURY_SERIF','CLASSIC_SERIF','TECHNICAL','COMPACT_UI',
]);
export const CUSTOMER_NAV_SLOTS = Object.freeze(['home','explore','cart','orders','profile']);
export const CUSTOMER_NAV_OPTION_CAPABILITIES = Object.freeze({
  nav_mobile:Object.freeze(['standard','ios_tab','floating_tab','minimal_tab','commerce_tab']),
  nav_labels:Object.freeze(['always','active_only','hidden']),
  nav_indicator:Object.freeze(['filled_icon','pill','dot','underline','background']),
  nav_container:Object.freeze(['edge','floating','glass']),
  nav_icon_size:Object.freeze(['size_20','size_22','size_24','size_26']),
  nav_active_style:Object.freeze(['outline','filled','duotone']),
  nav_inactive_style:Object.freeze(['outline','filled']),
});
export const CUSTOMER_BUTTON_OPTION_CAPABILITIES = Object.freeze({
  button_primary:Object.freeze(['solid','soft','outline','pill','ios_filled','ios_tonal','ios_outline','ios_soft','ios_pill']),
  button_secondary:Object.freeze(['soft','solid','outline','ghost','pill','ios_tonal','ios_outline','ios_plain','ios_soft']),
  button_tertiary:Object.freeze(['ghost','soft','outline','plain','ios_plain','ios_tonal','ios_outline']),
  button_destructive:Object.freeze(['solid','soft','outline','ios_destructive','ios_destructive_soft','ios_destructive_outline']),
  button_icon:Object.freeze(['round','square','ghost','ios_circle','ios_square','ios_plain']),
  button_size:Object.freeze(['compact','standard','large']),
});
export const CUSTOMER_FORM_OPTION_CAPABILITIES = Object.freeze({
  form_control:Object.freeze(['standard','ios_grouped','soft_filled','outline','minimal']),
  form_size:Object.freeze(['compact','standard','large']),
  form_group:Object.freeze(['standard','inset_grouped','card','flat']),
});
export const CUSTOMER_PRODUCT_OPTION_CAPABILITIES = Object.freeze({
  product_image_ratio:Object.freeze(['square','portrait','landscape','auto']),
  product_badge_position:Object.freeze(['top_left','top_right','inline','hidden']),
  product_price_layout:Object.freeze(['stacked','inline','emphasis','compact']),
  product_quick_add:Object.freeze(['hidden','button','icon']),
  product_density:Object.freeze(['compact','comfortable','spacious']),
  product_radius:Object.freeze(['small','medium','large','xl']),
  product_elevation:Object.freeze(['flat','soft','raised']),
});
export const CUSTOMER_TYPOGRAPHY_OPTION_CAPABILITIES = Object.freeze({
  typography_preset:Object.freeze(THEME_TYPOGRAPHY_PRESETS.map(value=>value.toLowerCase())),
  typography_scale:Object.freeze(['compact','standard','large']),
  typography_heading_weight:Object.freeze(['regular','semibold','bold','heavy']),
  typography_body_weight:Object.freeze(['regular','medium','semibold']),
  typography_caption_weight:Object.freeze(['regular','medium','semibold']),
  typography_button_weight:Object.freeze(['medium','semibold','bold']),
  typography_line_height:Object.freeze(['tight','standard','relaxed']),
  typography_letter_spacing:Object.freeze(['tight','normal','wide']),
});
const PHOSPHOR_NAV=[...THEME_ICON_PACKS.PHOSPHOR_NAV];
export const THEME_COMPONENT_CAPABILITIES = Object.freeze({
  CUSTOMER_WEB:Object.freeze({
    product_card:Object.freeze(['standard','minimal','soft','bold','technical','compact','quick_add','editorial']),
    nav_home_icon:Object.freeze(PHOSPHOR_NAV),
    nav_explore_icon:Object.freeze(PHOSPHOR_NAV),
    nav_cart_icon:Object.freeze(PHOSPHOR_NAV),
    nav_orders_icon:Object.freeze(PHOSPHOR_NAV),
    nav_profile_icon:Object.freeze(PHOSPHOR_NAV),
    ...CUSTOMER_NAV_OPTION_CAPABILITIES,
    ...CUSTOMER_BUTTON_OPTION_CAPABILITIES,
    ...CUSTOMER_FORM_OPTION_CAPABILITIES,
    ...CUSTOMER_PRODUCT_OPTION_CAPABILITIES,
    ...CUSTOMER_TYPOGRAPHY_OPTION_CAPABILITIES,
  }),
  STAFF_WEB:Object.freeze({workspace_card:Object.freeze(['standard','flat','outlined','compact'])}),
});

const ICON_PACK_DEFAULTS=Object.freeze({
  LUKE_OUTLINE:Object.freeze({home:'home',explore:'grid',cart:'bag',orders:'receipt',profile:'user'}),
  PHOSPHOR_NAV:Object.freeze({home:'house',explore:'storefront',cart:'shopping-bag',orders:'receipt',profile:'user-circle'}),
});
const NAV_OVERRIDE_TO_SLOT=Object.freeze({nav_home_icon:'home',nav_explore_icon:'explore',nav_cart_icon:'cart',nav_orders_icon:'orders',nav_profile_icon:'profile'});
const APP_SET=new Set(THEME_APPS),HEX=/^#[0-9a-fA-F]{6}$/,KEY=/^[A-Z][A-Z0-9_]{1,79}$/,VERSION=/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/,VARIANT=/^[a-z][a-z0-9_-]{0,63}$/,PACK_KEY=/^[A-Z][A-Z0-9_]{1,79}$/;
const FORBIDDEN_KEYS=/^(?:css|raw_css|style|styles|html|svg|script|scripts|javascript|js|code|executable)$/i;
const COLOR_KEYS=['primary','secondary','accent','background','surface','text','muted_text','success','danger'];
const cleanText=(value,max=240)=>String(value??'').trim().slice(0,max),pick=(value,allowed,fallback)=>allowed.includes(value)?value:fallback;

function rejectExecutable(value,depth=0){
  if(depth>8||value==null)return;
  if(Array.isArray(value)){for(const item of value.slice(0,200))rejectExecutable(item,depth+1);return;}
  if(typeof value!=='object')return;
  for(const[key,item]of Object.entries(value).slice(0,1000)){
    if(FORBIDDEN_KEYS.test(key))throw errors.badRequest('THEME_PACKAGE_EXECUTABLE_CONTENT_FORBIDDEN',`Theme packages cannot contain executable or raw presentation content (${key})`);
    rejectExecutable(item,depth+1);
  }
}
function safeIdentifier(value,fallback=''){const next=String(value||'').trim().toLowerCase();return VARIANT.test(next)?next:fallback;}
function safePackKey(value,fallback){const next=String(value||'').trim().toUpperCase();return PACK_KEY.test(next)?next:fallback;}
function safeHttps(value){const raw=cleanText(value,1500);if(!raw)return'';try{const url=new URL(raw);return url.protocol==='https:'?url.toString():'';}catch{return'';}}
function normalizeIconPack(value){const requested=safePackKey(value,'LUKE_OUTLINE');return Object.hasOwn(THEME_ICON_PACKS,requested)?requested:'LUKE_OUTLINE';}
function normalizeIconAllowList(pack,raw){const supported=THEME_ICON_PACKS[pack]||THEME_ICON_PACKS.LUKE_OUTLINE;if(!Array.isArray(raw)||!raw.length)return[...supported];const values=[...new Set(raw.map(v=>safeIdentifier(v)).filter(v=>v&&supported.includes(v)))].slice(0,80);return values.length?values:[...supported];}
function normalizeNavigationIconDefaults(pack,raw={},allowed=THEME_ICON_PACKS[pack]||[]){const source=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{},defaults=ICON_PACK_DEFAULTS[pack]||ICON_PACK_DEFAULTS.LUKE_OUTLINE,out={};for(const slot of CUSTOMER_NAV_SLOTS){const requested=safeIdentifier(source[slot]),fallback=allowed.includes(defaults[slot])?defaults[slot]:allowed[0];if(requested&&allowed.includes(requested))out[slot]=requested;else if(fallback)out[slot]=fallback;}return out;}

export function normalizeThemeNavigationIcons(raw={}){if(!raw||typeof raw!=='object'||Array.isArray(raw))return{};const out={};for(const slot of CUSTOMER_NAV_SLOTS){const icon=safeIdentifier(raw[slot]);if(icon)out[slot]=icon;}return out;}
export function validateThemeNavigationIcons(theme,raw={}){const overrides=normalizeThemeNavigationIcons(raw);if(!Object.keys(overrides).length)return{};if(!theme)throw errors.badRequest('THEME_ICON_THEME_REQUIRED','Choose a Customer Web theme before changing navigation icons');const icons=theme.manifest?.icons||{},pack=normalizeIconPack(icons.pack),rendererAllowed=THEME_ICON_PACKS[pack]||[],packageAllowed=normalizeIconAllowList(pack,icons.allowed);for(const[slot,icon]of Object.entries(overrides))if(!CUSTOMER_NAV_SLOTS.includes(slot)||!rendererAllowed.includes(icon)||!packageAllowed.includes(icon))throw errors.badRequest('THEME_NAV_ICON_NOT_ALLOWED',`Navigation icon ${slot}:${icon} is not allowed by the selected theme package`);return overrides;}
export function resolveThemeNavigationIcons(theme,rawOverrides={}){if(!theme)return{};const icons=theme.manifest?.icons||{},pack=normalizeIconPack(icons.pack),allowed=normalizeIconAllowList(pack,icons.allowed),defaults=normalizeNavigationIconDefaults(pack,icons.navigation_defaults,allowed),overrides=validateThemeNavigationIcons(theme,rawOverrides);return{...defaults,...overrides};}

export function normalizeThemeComponentOverrides(raw={}){if(!raw||typeof raw!=='object'||Array.isArray(raw))return{};const out={};for(const[key,value]of Object.entries(raw).slice(0,64)){const k=safeIdentifier(key),v=safeIdentifier(value);if(k&&v)out[k]=v;}return out;}
function normalizeVariantMap(raw={}){if(!raw||typeof raw!=='object'||Array.isArray(raw))return{};const out={};for(const[key,value]of Object.entries(raw).slice(0,120)){const k=safeIdentifier(key),v=safeIdentifier(value);if(k&&v)out[k]=v;}return out;}
function normalizeComponentOptions(raw={},supportedApps=THEME_APPS){if(!raw||typeof raw!=='object'||Array.isArray(raw))return{};const capabilities={};for(const app of supportedApps)Object.assign(capabilities,THEME_COMPONENT_CAPABILITIES[app]||{});const out={};for(const[rawKey,values]of Object.entries(raw).slice(0,64)){const key=safeIdentifier(rawKey),allowed=capabilities[key];if(!key||!allowed||!Array.isArray(values)||NAV_OVERRIDE_TO_SLOT[key])continue;const variants=[...new Set(values.map(v=>safeIdentifier(v)).filter(v=>v&&allowed.includes(v)))].slice(0,16);if(variants.length)out[key]=variants;}return out;}
export function validateThemeComponentOverrides(theme,app,raw={}){
  const normalizedApp=String(app||'').trim().toUpperCase(),capabilities=THEME_COMPONENT_CAPABILITIES[normalizedApp];
  if(!capabilities)throw errors.badRequest('THEME_APP_INVALID','Unsupported theme application');
  const overrides=normalizeThemeComponentOverrides(raw);if(!Object.keys(overrides).length)return{};
  if(!theme)throw errors.badRequest('THEME_COMPONENT_THEME_REQUIRED','Choose a theme package before changing component variants');
  const advertised=theme.manifest?.component_options||{},icons=theme.manifest?.icons||{},iconPack=normalizeIconPack(icons.pack),iconAllowed=normalizeIconAllowList(iconPack,icons.allowed);
  for(const[key,variant]of Object.entries(overrides)){
    const rendererAllowed=capabilities[key];
    if(NAV_OVERRIDE_TO_SLOT[key]){
      if(normalizedApp!=='CUSTOMER_WEB'||iconPack!=='PHOSPHOR_NAV'||!rendererAllowed?.includes(variant)||!iconAllowed.includes(variant))throw errors.badRequest('THEME_NAV_ICON_NOT_ALLOWED',`Navigation icon ${key}:${variant} is not allowed by the selected theme package`);
      continue;
    }
    const packageAllowed=Array.isArray(advertised[key])?advertised[key]:[];
    if(!rendererAllowed||!rendererAllowed.includes(variant)||!packageAllowed.includes(variant))throw errors.badRequest('THEME_COMPONENT_VARIANT_NOT_ALLOWED',`Component variant ${key}:${variant} is not allowed by the selected theme package`);
  }
  return overrides;
}
export function resolveThemeComponents(theme,app,rawOverrides={}){const normalizedApp=String(app||'').trim().toUpperCase(),capabilities=THEME_COMPONENT_CAPABILITIES[normalizedApp]||{},defaults=theme?.manifest?.components||{},overrides=normalizeThemeComponentOverrides(rawOverrides),effective={};for(const[key,allowed]of Object.entries(capabilities)){if(NAV_OVERRIDE_TO_SLOT[key]||Object.hasOwn(CUSTOMER_NAV_OPTION_CAPABILITIES,key)||Object.hasOwn(CUSTOMER_BUTTON_OPTION_CAPABILITIES,key))continue;const packageDefault=safeIdentifier(defaults[key]);if(packageDefault&&allowed.includes(packageDefault))effective[key]=packageDefault;const override=overrides[key];if(override&&allowed.includes(override))effective[key]=override;}return effective;}

export function resolveThemeNavigationSettings(theme,rawOverrides={}){
  if(!theme)return{};
  const manifest=theme.manifest||{},nav=manifest.navigation||{},icons=manifest.icons||{},advertised=manifest.component_options||{},overrides=normalizeThemeComponentOverrides(rawOverrides);
  const defaults={nav_mobile:nav.mobile||'standard',nav_labels:nav.labels||'always',nav_indicator:nav.active_indicator||'filled_icon',nav_container:nav.container||'edge',nav_icon_size:`size_${icons.size||24}`,nav_active_style:icons.active_style||'filled',nav_inactive_style:icons.inactive_style||'outline'};
  const out={...defaults};
  for(const[key,rendererAllowed]of Object.entries(CUSTOMER_NAV_OPTION_CAPABILITIES)){
    const requested=overrides[key],packageAllowed=Array.isArray(advertised[key])?advertised[key]:[];
    if(requested&&rendererAllowed.includes(requested)&&packageAllowed.includes(requested))out[key]=requested;
  }
  return out;
}

export function resolveThemeButtonSettings(theme,rawOverrides={}){
  if(!theme)return{};
  const manifest=theme.manifest||{},buttons=manifest.buttons||{},advertised=manifest.component_options||{},overrides=normalizeThemeComponentOverrides(rawOverrides);
  const defaults={button_primary:buttons.primary||'solid',button_secondary:buttons.secondary||'soft',button_tertiary:buttons.tertiary||'ghost',button_destructive:buttons.destructive||'solid',button_icon:buttons.icon||'round',button_size:buttons.size||'standard'};
  const out={...defaults};
  for(const[key,rendererAllowed]of Object.entries(CUSTOMER_BUTTON_OPTION_CAPABILITIES)){
    const requested=overrides[key],packageAllowed=Array.isArray(advertised[key])?advertised[key]:[];
    if(requested&&rendererAllowed.includes(requested)&&packageAllowed.includes(requested))out[key]=requested;
  }
  return out;
}

export function normalizeThemeManifest(raw={}, {supportedApps=THEME_APPS}={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw errors.badRequest('THEME_MANIFEST_INVALID','Theme manifest must be an object');
  rejectExecutable(raw);
  const schemaVersion=Number(raw.schema_version||1);if(schemaVersion!==1)throw errors.badRequest('THEME_SCHEMA_UNSUPPORTED','Only theme schema version 1 is supported');
  const foundations=raw.foundations&&typeof raw.foundations==='object'&&!Array.isArray(raw.foundations)?raw.foundations:{},colors=foundations.colors&&typeof foundations.colors==='object'&&!Array.isArray(foundations.colors)?foundations.colors:{},normalizedColors={};
  for(const key of COLOR_KEYS)if(HEX.test(String(colors[key]||'')))normalizedColors[key]=String(colors[key]).toLowerCase();
  const typography=raw.typography&&typeof raw.typography==='object'&&!Array.isArray(raw.typography)?raw.typography:{},icons=raw.icons&&typeof raw.icons==='object'&&!Array.isArray(raw.icons)?raw.icons:{},buttons=raw.buttons&&typeof raw.buttons==='object'&&!Array.isArray(raw.buttons)?raw.buttons:{},navigation=raw.navigation&&typeof raw.navigation==='object'&&!Array.isArray(raw.navigation)?raw.navigation:{},iconPack=normalizeIconPack(icons.pack),iconAllowed=normalizeIconAllowList(iconPack,icons.allowed),iconSize=Number(icons.size),typographyPreset=pick(safePackKey(typography.preset,'SYSTEM_MINIMAL'),THEME_TYPOGRAPHY_PRESETS,'SYSTEM_MINIMAL');
  return{
    schema_version:1,
    foundations:{colors:normalizedColors,radius:pick(foundations.radius,['small','medium','large','xl','pill'],'medium'),density:pick(foundations.density,['compact','comfortable','spacious'],'comfortable'),elevation:pick(foundations.elevation,['flat','soft','raised'],'soft'),motion:pick(foundations.motion,['reduced','standard','expressive'],'standard')},
    typography:{preset:typographyPreset,scale:pick(typography.scale,['compact','standard','large'],'standard'),heading_weight:pick(typography.heading_weight,['regular','semibold','bold','heavy'],'semibold'),body_weight:pick(typography.body_weight,['regular','medium','semibold'],'regular'),caption_weight:pick(typography.caption_weight,['regular','medium','semibold'],'regular'),button_weight:pick(typography.button_weight,['medium','semibold','bold'],'semibold'),line_height:pick(typography.line_height,['tight','standard','relaxed'],'standard'),letter_spacing:pick(typography.letter_spacing,['tight','normal','wide'],'normal')},
    icons:{pack:iconPack,active_style:pick(icons.active_style,['outline','filled','duotone'],'filled'),inactive_style:pick(icons.inactive_style,['outline','filled'],'outline'),size:[20,22,24,26].includes(iconSize)?iconSize:24,allowed:iconAllowed,navigation_defaults:normalizeNavigationIconDefaults(iconPack,icons.navigation_defaults,iconAllowed)},
    buttons:{primary:pick(safeIdentifier(buttons.primary),CUSTOMER_BUTTON_OPTION_CAPABILITIES.button_primary,'solid'),secondary:pick(safeIdentifier(buttons.secondary),CUSTOMER_BUTTON_OPTION_CAPABILITIES.button_secondary,'soft'),tertiary:pick(safeIdentifier(buttons.tertiary),CUSTOMER_BUTTON_OPTION_CAPABILITIES.button_tertiary,'ghost'),destructive:pick(safeIdentifier(buttons.destructive),CUSTOMER_BUTTON_OPTION_CAPABILITIES.button_destructive,'solid'),icon:pick(safeIdentifier(buttons.icon),CUSTOMER_BUTTON_OPTION_CAPABILITIES.button_icon,'round'),size:pick(buttons.size,CUSTOMER_BUTTON_OPTION_CAPABILITIES.button_size,'standard')},
    navigation:{mobile:pick(navigation.mobile,['standard','ios_tab','floating_tab','minimal_tab','commerce_tab'],'ios_tab'),desktop:pick(navigation.desktop,['header','header_centered','sidebar'],'header'),labels:pick(navigation.labels,['always','active_only','hidden'],'always'),active_indicator:pick(navigation.active_indicator,['filled_icon','pill','dot','underline','background'],'filled_icon'),container:pick(navigation.container,['edge','floating','glass'],'edge')},
    components:normalizeVariantMap(raw.components),component_options:normalizeComponentOptions(raw.component_options,supportedApps),
  };
}
export function normalizeThemePackageInput(raw={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw errors.badRequest('THEME_PACKAGE_INVALID','Theme package must be an object');
  const key=String(raw.key||'').trim().toUpperCase(),version=String(raw.version||'').trim(),name=cleanText(raw.name,120);
  if(!KEY.test(key))throw errors.badRequest('THEME_KEY_INVALID','Theme key must use uppercase letters, numbers and underscores');
  if(!VERSION.test(version))throw errors.badRequest('THEME_VERSION_INVALID','Theme version must use semantic versioning such as 1.0.0');
  if(name.length<2)throw errors.badRequest('THEME_NAME_INVALID','Theme name is required');
  const supportedApps=[...new Set((Array.isArray(raw.supported_apps)?raw.supported_apps:[]).map(v=>String(v||'').trim().toUpperCase()).filter(v=>APP_SET.has(v)))];
  if(!supportedApps.length)throw errors.badRequest('THEME_APP_REQUIRED','Theme package must support Customer Web and/or Staff Web');
  const preview=raw.preview&&typeof raw.preview==='object'&&!Array.isArray(raw.preview)?raw.preview:{};
  return{key,version,name,description:cleanText(raw.description,1000),supported_apps:supportedApps,manifest:normalizeThemeManifest(raw.manifest||{},{supportedApps}),preview:{summary:cleanText(preview.summary,360),figma_url:safeHttps(preview.figma_url),thumbnail_url:safeHttps(preview.thumbnail_url),tags:[...new Set((Array.isArray(preview.tags)?preview.tags:[]).map(v=>cleanText(v,40)).filter(Boolean))].slice(0,12)}};
}
export async function listThemePackages(db,{publishedOnly=false,app=null}={}){const normalizedApp=app?String(app).trim().toUpperCase():null;if(normalizedApp&&!APP_SET.has(normalizedApp))throw errors.badRequest('THEME_APP_INVALID','Unsupported theme application');const result=await db.query(`SELECT key,version,name,description,status,supported_apps,manifest,preview,created_at,updated_at,published_at FROM platform_theme_packages WHERE ($1::boolean=false OR status='PUBLISHED') AND ($2::text IS NULL OR supported_apps ? $2) ORDER BY key,created_at DESC`,[publishedOnly,normalizedApp]);return result.rows;}