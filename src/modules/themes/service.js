import { errors } from '../../core/errors.js';

export const THEME_APPS = Object.freeze(['CUSTOMER_WEB','STAFF_WEB']);
export const THEME_STATUS = Object.freeze(['DRAFT','PUBLISHED','RETIRED']);
export const THEME_COMPONENT_CAPABILITIES = Object.freeze({
  CUSTOMER_WEB:Object.freeze({
    product_card:Object.freeze(['standard','minimal','soft','bold','technical','compact','quick_add','editorial']),
  }),
  STAFF_WEB:Object.freeze({
    workspace_card:Object.freeze(['standard','flat','outlined','compact']),
  }),
});

const APP_SET = new Set(THEME_APPS);
const HEX = /^#[0-9a-fA-F]{6}$/;
const KEY = /^[A-Z][A-Z0-9_]{1,79}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const VARIANT = /^[a-z][a-z0-9_-]{0,63}$/;
const PACK_KEY = /^[A-Z][A-Z0-9_]{1,79}$/;
const FORBIDDEN_KEYS = /^(?:css|raw_css|style|styles|html|svg|script|scripts|javascript|js|code|executable)$/i;
const COLOR_KEYS = ['primary','secondary','accent','background','surface','text','muted_text','success','danger'];

const cleanText = (value, max = 240) => String(value ?? '').trim().slice(0, max);
const pick = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;

function rejectExecutable(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 200)) rejectExecutable(item, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value).slice(0, 1000)) {
    if (FORBIDDEN_KEYS.test(key)) {
      throw errors.badRequest('THEME_PACKAGE_EXECUTABLE_CONTENT_FORBIDDEN', `Theme packages cannot contain executable or raw presentation content (${key})`);
    }
    rejectExecutable(item, depth + 1);
  }
}

function safeIdentifier(value, fallback = '') {
  const next = String(value || '').trim().toLowerCase();
  return VARIANT.test(next) ? next : fallback;
}

function safePackKey(value, fallback) {
  const next = String(value || '').trim().toUpperCase();
  return PACK_KEY.test(next) ? next : fallback;
}

function safeHttps(value) {
  const raw = cleanText(value, 1500);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

export function normalizeThemeComponentOverrides(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw).slice(0, 24)) {
    const safeKey = safeIdentifier(key);
    const safeValue = safeIdentifier(value);
    if (safeKey && safeValue) out[safeKey] = safeValue;
  }
  return out;
}

function normalizeVariantMap(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw).slice(0, 120)) {
    const safeKey = safeIdentifier(key);
    const safeValue = safeIdentifier(value);
    if (safeKey && safeValue) out[safeKey] = safeValue;
  }
  return out;
}

function normalizeComponentOptions(raw = {}, supportedApps = THEME_APPS) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const capabilities = {};
  for (const app of supportedApps) Object.assign(capabilities, THEME_COMPONENT_CAPABILITIES[app] || {});
  const out = {};
  for (const [rawKey, values] of Object.entries(raw).slice(0, 24)) {
    const key = safeIdentifier(rawKey);
    const allowed = capabilities[key];
    if (!key || !allowed || !Array.isArray(values)) continue;
    const variants = [...new Set(values.map(value=>safeIdentifier(value)).filter(value=>value && allowed.includes(value)))].slice(0, 16);
    if (variants.length) out[key] = variants;
  }
  return out;
}

export function validateThemeComponentOverrides(theme, app, raw = {}) {
  const normalizedApp = String(app || '').trim().toUpperCase();
  const capabilities = THEME_COMPONENT_CAPABILITIES[normalizedApp];
  if (!capabilities) throw errors.badRequest('THEME_APP_INVALID', 'Unsupported theme application');
  const overrides = normalizeThemeComponentOverrides(raw);
  if (!Object.keys(overrides).length) return {};
  if (!theme) throw errors.badRequest('THEME_COMPONENT_THEME_REQUIRED', 'Choose a theme package before changing component variants');
  const advertised = theme.manifest?.component_options || {};
  for (const [key, variant] of Object.entries(overrides)) {
    const rendererAllowed = capabilities[key];
    const packageAllowed = Array.isArray(advertised[key]) ? advertised[key] : [];
    if (!rendererAllowed || !rendererAllowed.includes(variant) || !packageAllowed.includes(variant)) {
      throw errors.badRequest('THEME_COMPONENT_VARIANT_NOT_ALLOWED', `Component variant ${key}:${variant} is not allowed by the selected theme package`);
    }
  }
  return overrides;
}

export function resolveThemeComponents(theme, app, rawOverrides = {}) {
  const normalizedApp = String(app || '').trim().toUpperCase();
  const capabilities = THEME_COMPONENT_CAPABILITIES[normalizedApp] || {};
  const defaults = theme?.manifest?.components || {};
  const overrides = normalizeThemeComponentOverrides(rawOverrides);
  const effective = {};
  for (const [key, allowed] of Object.entries(capabilities)) {
    const packageDefault = safeIdentifier(defaults[key]);
    if (packageDefault && allowed.includes(packageDefault)) effective[key] = packageDefault;
    const override = overrides[key];
    if (override && allowed.includes(override)) effective[key] = override;
  }
  return effective;
}

export function normalizeThemeManifest(raw = {}, { supportedApps = THEME_APPS } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw errors.badRequest('THEME_MANIFEST_INVALID', 'Theme manifest must be an object');
  }
  rejectExecutable(raw);
  const schemaVersion = Number(raw.schema_version || 1);
  if (schemaVersion !== 1) throw errors.badRequest('THEME_SCHEMA_UNSUPPORTED', 'Only theme schema version 1 is supported');

  const foundations = raw.foundations && typeof raw.foundations === 'object' && !Array.isArray(raw.foundations) ? raw.foundations : {};
  const colors = foundations.colors && typeof foundations.colors === 'object' && !Array.isArray(foundations.colors) ? foundations.colors : {};
  const normalizedColors = {};
  for (const key of COLOR_KEYS) {
    if (HEX.test(String(colors[key] || ''))) normalizedColors[key] = String(colors[key]).toLowerCase();
  }

  const typography = raw.typography && typeof raw.typography === 'object' && !Array.isArray(raw.typography) ? raw.typography : {};
  const icons = raw.icons && typeof raw.icons === 'object' && !Array.isArray(raw.icons) ? raw.icons : {};
  const buttons = raw.buttons && typeof raw.buttons === 'object' && !Array.isArray(raw.buttons) ? raw.buttons : {};
  const navigation = raw.navigation && typeof raw.navigation === 'object' && !Array.isArray(raw.navigation) ? raw.navigation : {};

  const iconSize = Number(icons.size);
  return {
    schema_version: 1,
    foundations: {
      colors: normalizedColors,
      radius: pick(foundations.radius, ['small','medium','large','xl','pill'], 'medium'),
      density: pick(foundations.density, ['compact','comfortable','spacious'], 'comfortable'),
      elevation: pick(foundations.elevation, ['flat','soft','raised'], 'soft'),
      motion: pick(foundations.motion, ['reduced','standard','expressive'], 'standard'),
    },
    typography: {
      preset: safePackKey(typography.preset, 'SYSTEM_MINIMAL'),
      scale: pick(typography.scale, ['compact','standard','large'], 'standard'),
    },
    icons: {
      pack: safePackKey(icons.pack, 'LUKE_OUTLINE'),
      active_style: pick(icons.active_style, ['outline','filled','duotone'], 'filled'),
      inactive_style: pick(icons.inactive_style, ['outline','filled'], 'outline'),
      size: [20,22,24,26].includes(iconSize) ? iconSize : 24,
    },
    buttons: {
      primary: safeIdentifier(buttons.primary, 'solid'),
      secondary: safeIdentifier(buttons.secondary, 'soft'),
      tertiary: safeIdentifier(buttons.tertiary, 'ghost'),
      destructive: safeIdentifier(buttons.destructive, 'solid'),
      icon: safeIdentifier(buttons.icon, 'round'),
      size: pick(buttons.size, ['compact','standard','large'], 'standard'),
    },
    navigation: {
      mobile: pick(navigation.mobile, ['standard','ios_tab','floating_tab','minimal_tab','commerce_tab'], 'ios_tab'),
      desktop: pick(navigation.desktop, ['header','header_centered','sidebar'], 'header'),
      labels: pick(navigation.labels, ['always','active_only','hidden'], 'always'),
      active_indicator: pick(navigation.active_indicator, ['filled_icon','pill','dot','underline','background'], 'filled_icon'),
      container: pick(navigation.container, ['edge','floating','glass'], 'edge'),
    },
    components: normalizeVariantMap(raw.components),
    component_options: normalizeComponentOptions(raw.component_options, supportedApps),
  };
}

export function normalizeThemePackageInput(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw errors.badRequest('THEME_PACKAGE_INVALID', 'Theme package must be an object');
  }
  const key = String(raw.key || '').trim().toUpperCase();
  const version = String(raw.version || '').trim();
  const name = cleanText(raw.name, 120);
  if (!KEY.test(key)) throw errors.badRequest('THEME_KEY_INVALID', 'Theme key must use uppercase letters, numbers and underscores');
  if (!VERSION.test(version)) throw errors.badRequest('THEME_VERSION_INVALID', 'Theme version must use semantic versioning such as 1.0.0');
  if (name.length < 2) throw errors.badRequest('THEME_NAME_INVALID', 'Theme name is required');

  const supportedApps = [...new Set((Array.isArray(raw.supported_apps) ? raw.supported_apps : []).map((value) => String(value || '').trim().toUpperCase()).filter((value) => APP_SET.has(value)))];
  if (!supportedApps.length) throw errors.badRequest('THEME_APP_REQUIRED', 'Theme package must support Customer Web and/or Staff Web');

  const preview = raw.preview && typeof raw.preview === 'object' && !Array.isArray(raw.preview) ? raw.preview : {};
  return {
    key,
    version,
    name,
    description: cleanText(raw.description, 1000),
    supported_apps: supportedApps,
    manifest: normalizeThemeManifest(raw.manifest || {}, { supportedApps }),
    preview: {
      summary: cleanText(preview.summary, 360),
      figma_url: safeHttps(preview.figma_url),
      thumbnail_url: safeHttps(preview.thumbnail_url),
      tags: [...new Set((Array.isArray(preview.tags) ? preview.tags : []).map((value) => cleanText(value, 40)).filter(Boolean))].slice(0, 12),
    },
  };
}

export async function listThemePackages(db, { publishedOnly = false, app = null } = {}) {
  const normalizedApp = app ? String(app).trim().toUpperCase() : null;
  if (normalizedApp && !APP_SET.has(normalizedApp)) throw errors.badRequest('THEME_APP_INVALID', 'Unsupported theme application');
  const result = await db.query(
    `SELECT key,version,name,description,status,supported_apps,manifest,preview,created_at,updated_at,published_at
       FROM platform_theme_packages
      WHERE ($1::boolean=false OR status='PUBLISHED')
        AND ($2::text IS NULL OR supported_apps ? $2)
      ORDER BY key,created_at DESC`,
    [publishedOnly, normalizedApp],
  );
  return result.rows;
}