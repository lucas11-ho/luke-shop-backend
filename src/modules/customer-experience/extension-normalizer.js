const LOCALE = /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})?$/;
const COUNTRY = /^[A-Z]{2}$/;
const FOOTER_DESTINATIONS = new Set(['home','explore','cart','orders','profile','signin']);
const FOOTER_SOCIAL_NETWORKS = new Set(['facebook','instagram','telegram','tiktok','youtube','x']);
const FOOTER_LAYOUTS = new Set(['columns','compact','minimal']);
const EXPLORE_HERO_STYLES = new Set(['standard','compact','minimal']);
const EXPLORE_CATEGORY_STYLES = new Set(['rail','chips','cards']);
const EXPLORE_PAGE_SIZES = new Set([12,24,36,48]);
const EXPLORE_LOAD_MORE_STYLES = new Set(['button','quiet']);
const cleanText = (value, max = 240) => String(value ?? '').trim().slice(0, max);
const cleanLocale = (value) => {
  const raw = String(value || '').trim().replace('_', '-');
  if (!raw || !LOCALE.test(raw)) return '';
  const [head, ...rest] = raw.split('-');
  return [head.toLowerCase(), ...rest.map((x) => x.toUpperCase())].join('-');
};
const cleanCountry = (value) => {
  const code = String(value || '').trim().toUpperCase();
  return COUNTRY.test(code) ? code : '';
};
const cleanHttpsUrl = (value) => {
  const raw = cleanText(value, 1500);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
};

function sanitizeTree(value, depth = 0) {
  if (depth > 7) return undefined;
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.slice(0, 6000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeTree(item, depth + 1)).filter((item) => item !== undefined);
  if (typeof value !== 'object') return undefined;
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 2500)) {
    const safeKey = String(key).slice(0, 180);
    const safe = sanitizeTree(item, depth + 1);
    if (safe !== undefined) out[safeKey] = safe;
  }
  return out;
}

function normalizeLocalization(raw = {}) {
  const hasLocalization = (raw.localization && typeof raw.localization === 'object') || (raw.languages && typeof raw.languages === 'object');
  if (!hasLocalization) return { enabled:true, default_locale:'', enabled_locales:[], locales:[], translations:{}, ui:{} };
  const source = raw.localization && typeof raw.localization === 'object'
    ? raw.localization
    : raw.languages && typeof raw.languages === 'object' ? raw.languages : {};
  const configured = Array.isArray(source.locales) ? source.locales : [];
  const localeRows = [];
  const seen = new Set();
  for (const row of configured) {
    const code = cleanLocale(row?.code);
    if (!code || seen.has(code) || localeRows.length >= 4) continue;
    seen.add(code);
    localeRows.push({
      code,
      label: cleanText(row?.label || row?.name || code.toUpperCase(), 80),
      native_label: cleanText(row?.native_label || row?.nativeLabel || row?.label || row?.name || code.toUpperCase(), 80),
      enabled: row?.enabled !== false,
    });
  }

  let enabled = Array.isArray(source.enabled_locales)
    ? source.enabled_locales.map(cleanLocale).filter(Boolean)
    : localeRows.filter((row) => row.enabled !== false).map((row) => row.code);
  enabled = [...new Set(enabled)].slice(0, 4);
  if (!enabled.length) enabled = ['en'];
  for (const code of enabled) {
    if (!localeRows.some((row) => row.code === code) && localeRows.length < 4) {
      localeRows.push({ code, label: code.toUpperCase(), native_label: code.toUpperCase(), enabled: true });
    }
  }
  const requestedDefault = cleanLocale(source.default_locale) || enabled[0] || 'en';
  const defaultLocale = enabled.includes(requestedDefault) ? requestedDefault : enabled[0];
  return {
    enabled: source.enabled !== false,
    default_locale: defaultLocale,
    enabled_locales: enabled,
    locales: localeRows.slice(0, 4),
    translations: sanitizeTree(source.translations || {}) || {},
    ui: sanitizeTree(source.ui || {}) || {},
  };
}

function normalizeAddressPolicy(raw = {}) {
  const delivery = raw.delivery && typeof raw.delivery === 'object' ? raw.delivery : {};
  const fields = delivery.address_fields && typeof delivery.address_fields === 'object'
    ? delivery.address_fields
    : raw.address_fields && typeof raw.address_fields === 'object' ? raw.address_fields : {};
  const bool = (value, fallback = true) => typeof value === 'boolean' ? value : fallback;
  return {
    address_fields: {
      label: bool(fields.label),
      country_code: bool(fields.country_code),
      address_line_2: bool(fields.address_line_2),
      postal_code: bool(fields.postal_code),
      default_country_code: cleanCountry(fields.default_country_code || delivery.default_country_code),
    },
  };
}

function normalizeFooter(raw = {}) {
  const source = raw.footer && typeof raw.footer === 'object' && !Array.isArray(raw.footer) ? raw.footer : {};
  const groups = Array.isArray(source.groups) ? source.groups.slice(0, 4).map((group, groupIndex) => {
    const links = Array.isArray(group?.links) ? group.links.slice(0, 6).map((link, linkIndex) => {
      const destination = FOOTER_DESTINATIONS.has(link?.destination) ? link.destination : '';
      if (!destination) return null;
      return {
        id: cleanText(link?.id || `link-${groupIndex + 1}-${linkIndex + 1}`, 80),
        label: cleanText(link?.label, 80),
        destination,
      };
    }).filter(Boolean) : [];
    return {
      id: cleanText(group?.id || `group-${groupIndex + 1}`, 80),
      title: cleanText(group?.title, 80),
      links,
    };
  }) : [];
  const socialLinks = Array.isArray(source.social_links) ? source.social_links.slice(0, 6).map((link) => {
    const network = String(link?.network || '').trim().toLowerCase();
    const url = cleanHttpsUrl(link?.url);
    if (!FOOTER_SOCIAL_NETWORKS.has(network) || !url) return null;
    return { network, url };
  }).filter(Boolean) : [];
  return {
    enabled: source.enabled === true,
    layout: FOOTER_LAYOUTS.has(source.layout) ? source.layout : 'columns',
    tagline: cleanText(source.tagline, 240),
    show_brand: source.show_brand !== false,
    show_copyright: source.show_copyright !== false,
    copyright_text: cleanText(source.copyright_text, 180),
    groups,
    social_links: socialLinks,
  };
}

function normalizeExplore(raw = {}) {
  const source = raw.explore && typeof raw.explore === 'object' && !Array.isArray(raw.explore) ? raw.explore : {};
  const categories = source.categories && typeof source.categories === 'object' && !Array.isArray(source.categories) ? source.categories : {};
  const requestedPageSize = Number(source.page_size);
  return {
    hero_style: EXPLORE_HERO_STYLES.has(source.hero_style) ? source.hero_style : 'standard',
    show_result_count: source.show_result_count !== false,
    show_category_description: source.show_category_description === true,
    categories: {
      enabled: categories.enabled !== false,
      style: EXPLORE_CATEGORY_STYLES.has(categories.style) ? categories.style : 'rail',
      show_images: categories.show_images === true,
    },
    page_size: EXPLORE_PAGE_SIZES.has(requestedPageSize) ? requestedPageSize : 24,
    load_more_style: EXPLORE_LOAD_MORE_STYLES.has(source.load_more_style) ? source.load_more_style : 'button',
  };
}

export function normalizeExperienceExtensions(raw = {}) {
  return {
    localization: normalizeLocalization(raw),
    delivery: normalizeAddressPolicy(raw),
    footer: normalizeFooter(raw),
    explore: normalizeExplore(raw),
  };
}

const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(Math.round(number), max)) : fallback;
};

export async function loadTenantExperiencePolicy(db, tenantId) {
  const result = await db.query(
    `SELECT p.limits AS override_limits,p.capabilities AS override_capabilities,
            pl.limits AS plan_limits,pl.capabilities AS plan_capabilities
       FROM tenant_platform_profiles p
       JOIN platform_plans pl ON pl.key=p.plan_key
      WHERE p.tenant_id=$1`,
    [tenantId],
  );
  if (!result.rowCount) {
    return { localization:true, address_field_policy:true, pwa:true, language_limit:4 };
  }
  const row = result.rows[0];
  const capabilities = { ...(row.plan_capabilities || {}), ...(row.override_capabilities || {}) };
  const limits = { ...(row.plan_limits || {}), ...(row.override_limits || {}) };
  return {
    localization: capabilities.storefront_localization !== false,
    address_field_policy: capabilities.address_field_policy !== false,
    pwa: capabilities.pwa !== false,
    language_limit: clamp(limits.storefront_languages ?? limits.customer_languages, 1, 4, 4),
  };
}

export function applyTenantExperiencePolicy(config = {}, policy = {}) {
  const next = JSON.parse(JSON.stringify(config || {}));
  const limit = clamp(policy.language_limit, 1, 4, 4);
  if (!next.localization) next.localization = normalizeLocalization({});
  const localizationConfigured = Boolean(next.localization.default_locale || next.localization.enabled_locales?.length || next.localization.locales?.length || Object.keys(next.localization.translations || {}).length);
  if (policy.localization === false) next.localization.enabled = false;
  if (!localizationConfigured) return next;
  next.localization.enabled_locales = (next.localization.enabled_locales || ['en']).slice(0, limit);
  if (!next.localization.enabled_locales.length) next.localization.enabled_locales = ['en'];
  next.localization.locales = (next.localization.locales || []).filter((row) => next.localization.enabled_locales.includes(row.code)).slice(0, limit);
  if (!next.localization.enabled_locales.includes(next.localization.default_locale)) {
    next.localization.default_locale = next.localization.enabled_locales[0];
  }
  if (policy.address_field_policy === false) {
    next.delivery = {
      ...(next.delivery || {}),
      address_fields: { label:true, country_code:true, address_line_2:true, postal_code:true, default_country_code:'' },
    };
  }
  return next;
}
