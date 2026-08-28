import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';
import { normalizeExperienceExtensions, loadTenantExperiencePolicy, applyTenantExperiencePolicy } from './extension-normalizer.js';

const NAV = new Set(['home','explore','cart','orders','profile']);
const SECTION_TYPES = new Set(['announcement_bar','hero','hero_slider','categories','featured_products','promotion_banner','new_arrivals']);
const PRODUCT_DETAIL_INFO_BLOCKS = new Set(['availability','fulfillment','options']);
const COLOR = /^#[0-9a-fA-F]{6}$/;
const text = (value, max = 500) => String(value ?? '').slice(0, max);
const color = (value, fallback) => COLOR.test(String(value || '')) ? String(value) : fallback;
const oneOf = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const integer = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(Math.round(n), max)) : fallback;
};

const THEME_DEFAULT = Object.freeze({
  preset:'modern', primary:'#166534', secondary:'#111827', accent:'#14b8a6', background:'#f8fafc', surface:'#ffffff', text:'#172033', muted_text:'#667085', success:'#15803d', danger:'#b42318',
  radius:'medium', card_style:'clean', button_style:'solid', density:'comfortable',
});
const TYPOGRAPHY_DEFAULT = Object.freeze({ preset:'SYSTEM_MINIMAL', heading_scale:'normal', body_scale:'normal', letter_spacing:'normal', button_case:'none' });
const LAYOUT_DEFAULT = Object.freeze({ header:'logo_left', hero:'split', categories:'cards', product_grid:'four', product_card:'standard', mobile_nav:'standard' });
const RESPONSIVE_DEFAULT = Object.freeze({ product_columns:{ desktop:4, tablet:3, mobile:2 }, hero_media_position:{ desktop:'right', tablet:'right', mobile:'below' } });
const PRODUCT_DETAIL_DEFAULT = Object.freeze({
  gallery_style:'thumbnails', buy_box_style:'sticky', mobile_buy_bar:true,
  related_products:{ enabled:true, limit:4 },
  visibility:{ category:true, discount:true, description:true, support:true },
  info_blocks:['availability','fulfillment','options'],
});
export const STATUS_VISUAL_PACKS = Object.freeze(['AUTO','MODERN','FASHION_LUXURY','RESTAURANT_MODERN','ELECTRONICS_PRO','GROCERY_CLEAN','DIGITAL_CREATOR']);
export const STATUS_VISUAL_ICON_KEYS = Object.freeze(['clock','alert-triangle','check-circle','cog','package','shopping-bag','truck','scooter','package-check','gift','receipt','chef-hat','home','radar','x-circle','unlock','sparkles','download']);
export const STATUS_VISUAL_STATUSES = Object.freeze(['PENDING','PENDING_PAYMENT','PAYMENT_FAILED','PAID','CONFIRMED','PROCESSING','RESTAURANT_ACCEPTED','PREPARING','READY','SHIPPED','OUT_FOR_DELIVERY','PICKED_UP','DELIVERED','COMPLETED','FULFILLED','FAILED','CANCELLED','REFUNDED','ACCESS_GRANTED','AVAILABLE','DOWNLOADED']);
const STATUS_VISUAL_PRESET_MAP = Object.freeze({ luxury:'FASHION_LUXURY',fashion:'FASHION_LUXURY',fashion_modern:'FASHION_LUXURY',bold:'FASHION_LUXURY',restaurant:'RESTAURANT_MODERN',fast_food:'RESTAURANT_MODERN',cafe:'RESTAURANT_MODERN',electronics:'ELECTRONICS_PRO',grocery:'GROCERY_CLEAN',creator:'DIGITAL_CREATOR',modern:'MODERN',ios_minimal:'MODERN',general:'MODERN' });
export function resolveStatusVisualPackKey(config = {}) {
  const explicit = String(config?.status_visual_pack || 'AUTO').toUpperCase();
  if (explicit !== 'AUTO' && STATUS_VISUAL_PACKS.includes(explicit)) return explicit;
  return STATUS_VISUAL_PRESET_MAP[String(config?.theme?.preset || '').toLowerCase()] || 'MODERN';
}
export async function resolveStatusVisualPack(db, config = {}) {
  const key = resolveStatusVisualPackKey(config);
  const result = await db.query(`SELECT key,name,business_type,status,icons,settings FROM platform_status_visual_packs WHERE key=$1 AND status='ACTIVE'`, [key]);
  return result.rows[0] || { key:'MODERN', name:'Modern', business_type:'GENERAL', status:'ACTIVE', icons:{}, settings:{} };
}

function normalizeSlides(value = []) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 6).map((slide, index) => ({
    id: text(slide?.id || `slide-${index + 1}`, 80),
    title: text(slide?.title, 180),
    body: text(slide?.body, 800),
    image_url: text(slide?.image_url, 1500),
    cta_label: text(slide?.cta_label, 80),
    cta_path: text(slide?.cta_path, 200),
  }));
}

function normalizeProductDetail(value = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const related = raw.related_products && typeof raw.related_products === 'object' && !Array.isArray(raw.related_products) ? raw.related_products : {};
  const visibility = raw.visibility && typeof raw.visibility === 'object' && !Array.isArray(raw.visibility) ? raw.visibility : {};
  const requestedBlocks = Array.isArray(raw.info_blocks) ? raw.info_blocks : PRODUCT_DETAIL_DEFAULT.info_blocks;
  const infoBlocks = [...new Set(requestedBlocks.filter((item) => PRODUCT_DETAIL_INFO_BLOCKS.has(item)))].slice(0, PRODUCT_DETAIL_INFO_BLOCKS.size);
  return {
    gallery_style: oneOf(raw.gallery_style,['thumbnails','stacked'],PRODUCT_DETAIL_DEFAULT.gallery_style),
    buy_box_style: oneOf(raw.buy_box_style,['sticky','standard'],PRODUCT_DETAIL_DEFAULT.buy_box_style),
    mobile_buy_bar: raw.mobile_buy_bar !== false,
    related_products: {
      enabled: related.enabled !== false,
      limit: integer(related.limit,1,8,PRODUCT_DETAIL_DEFAULT.related_products.limit),
    },
    visibility: {
      category: visibility.category !== false,
      discount: visibility.discount !== false,
      description: visibility.description !== false,
      support: visibility.support !== false,
    },
    info_blocks: infoBlocks.length ? infoBlocks : [],
  };
}

export function normalizeExperienceConfig(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const theme = raw.theme && typeof raw.theme === 'object' ? raw.theme : {};
  const typography = raw.typography && typeof raw.typography === 'object' ? raw.typography : {};
  const layout = raw.layout && typeof raw.layout === 'object' ? raw.layout : {};
  const branding = raw.branding && typeof raw.branding === 'object' ? raw.branding : {};
  const home = raw.home && typeof raw.home === 'object' ? raw.home : {};
  const seo = raw.seo && typeof raw.seo === 'object' ? raw.seo : {};
  const responsive = raw.responsive && typeof raw.responsive === 'object' ? raw.responsive : {};
  const columns = responsive.product_columns && typeof responsive.product_columns === 'object' ? responsive.product_columns : {};
  const heroPosition = responsive.hero_media_position && typeof responsive.hero_media_position === 'object' ? responsive.hero_media_position : {};
  const sections = Array.isArray(home.sections) ? home.sections.slice(0, 24).map((section, index) => {
    const type = SECTION_TYPES.has(section?.type) ? section.type : null;
    if (!type) return null;
    return {
      id: text(section.id || `${type}-${index + 1}`, 80), type, enabled: section.enabled !== false,
      title: text(section.title, 180), body: text(section.body, 800), image_url: text(section.image_url, 1500),
      video_url: text(section.video_url, 1500), poster_url: text(section.poster_url, 1500), product_ref: text(section.product_ref, 140),
      cta_label: text(section.cta_label, 80), cta_path: text(section.cta_path, 200), limit: integer(section.limit, 1, 24, 8),
      slides: normalizeSlides(section.slides),
    };
  }).filter(Boolean) : [];
  const navigation = Array.isArray(raw.navigation) ? raw.navigation.filter((item) => NAV.has(item)).slice(0, 5) : ['home','explore','cart','orders','profile'];
  return {
    schema_version: 4,
    ...normalizeExperienceExtensions(raw),
    status_visual_pack: oneOf(String(raw.status_visual_pack || 'AUTO').toUpperCase(), STATUS_VISUAL_PACKS, 'AUTO'),
    theme: {
      preset: text(theme.preset || THEME_DEFAULT.preset, 60),
      primary: color(theme.primary, THEME_DEFAULT.primary), secondary: color(theme.secondary, THEME_DEFAULT.secondary), accent: color(theme.accent, theme.primary || THEME_DEFAULT.accent),
      background: color(theme.background, THEME_DEFAULT.background), surface: color(theme.surface, THEME_DEFAULT.surface), text: color(theme.text, THEME_DEFAULT.text), muted_text: color(theme.muted_text, THEME_DEFAULT.muted_text),
      success: color(theme.success, THEME_DEFAULT.success), danger: color(theme.danger, THEME_DEFAULT.danger),
      radius: oneOf(theme.radius,['small','medium','large','xl'],THEME_DEFAULT.radius),
      card_style: oneOf(theme.card_style,['clean','soft','editorial','bold','technical'],THEME_DEFAULT.card_style),
      button_style: oneOf(theme.button_style,['solid','pill','outline','soft'],THEME_DEFAULT.button_style),
      density: oneOf(theme.density,['compact','comfortable','spacious'],THEME_DEFAULT.density),
    },
    typography: {
      preset: text(typography.preset || TYPOGRAPHY_DEFAULT.preset, 60),
      heading_scale: oneOf(typography.heading_scale,['compact','normal','large','display'],TYPOGRAPHY_DEFAULT.heading_scale),
      body_scale: oneOf(typography.body_scale,['compact','normal','large'],TYPOGRAPHY_DEFAULT.body_scale),
      letter_spacing: oneOf(typography.letter_spacing,['tight','normal','wide'],TYPOGRAPHY_DEFAULT.letter_spacing),
      button_case: oneOf(typography.button_case,['none','uppercase'],TYPOGRAPHY_DEFAULT.button_case),
    },
    layout: {
      header: oneOf(layout.header,['logo_left','centered_logo','search_first','compact','transparent'],LAYOUT_DEFAULT.header),
      hero: oneOf(layout.hero,['split','full_width','slider','featured_product','video','minimal'],LAYOUT_DEFAULT.hero),
      categories: oneOf(layout.categories,['cards','circles','image_tiles','chips','horizontal'],LAYOUT_DEFAULT.categories),
      product_grid: oneOf(layout.product_grid,['two','three','four','editorial','compact','horizontal'],LAYOUT_DEFAULT.product_grid),
      product_card: oneOf(layout.product_card,['standard','minimal','soft','bold','technical','compact','quick_add','editorial'],LAYOUT_DEFAULT.product_card),
      mobile_nav: oneOf(layout.mobile_nav,['standard','ios','compact'],LAYOUT_DEFAULT.mobile_nav),
    },
    branding: {
      use_internal_name: branding.use_internal_name === true,
      store_name: text(branding.store_name, 120), announcement: text(branding.announcement, 240), hero_title: text(branding.hero_title, 180),
      hero_subtitle: text(branding.hero_subtitle, 500), logo_url: text(branding.logo_url, 1500), favicon_url: text(branding.favicon_url,1500),
    },
    seo: {
      title: text(seo.title, 160), description: text(seo.description, 320), social_image_url: text(seo.social_image_url, 1500),
    },
    responsive: {
      product_columns: {
        desktop: integer(columns.desktop, 2, 6, RESPONSIVE_DEFAULT.product_columns.desktop),
        tablet: integer(columns.tablet, 1, 4, RESPONSIVE_DEFAULT.product_columns.tablet),
        mobile: integer(columns.mobile, 1, 2, RESPONSIVE_DEFAULT.product_columns.mobile),
      },
      hero_media_position: {
        desktop: oneOf(heroPosition.desktop,['right','left','below','hidden'],RESPONSIVE_DEFAULT.hero_media_position.desktop),
        tablet: oneOf(heroPosition.tablet,['right','left','below','hidden'],RESPONSIVE_DEFAULT.hero_media_position.tablet),
        mobile: oneOf(heroPosition.mobile,['right','left','below','hidden'],RESPONSIVE_DEFAULT.hero_media_position.mobile),
      },
    },
    product_detail: normalizeProductDetail(raw.product_detail),
    navigation: navigation.length ? [...new Set(navigation)] : ['home','explore','cart','orders','profile'],
    home: { sections: sections.length ? sections : [
      { id:'hero',type:'hero',enabled:true,title:'',body:'',image_url:'',video_url:'',poster_url:'',product_ref:'',cta_label:'',cta_path:'',limit:8,slides:[] },
      { id:'categories',type:'categories',enabled:true,title:'',body:'',image_url:'',video_url:'',poster_url:'',product_ref:'',cta_label:'',cta_path:'',limit:8,slides:[] },
      { id:'featured',type:'featured_products',enabled:true,title:'',body:'',image_url:'',video_url:'',poster_url:'',product_ref:'',cta_label:'',cta_path:'',limit:8,slides:[] },
    ] },
    features: raw.features && typeof raw.features === 'object' && !Array.isArray(raw.features) ? {
      search: raw.features.search !== false, promotions: raw.features.promotions !== false, support: raw.features.support !== false,
      ratings: raw.features.ratings === true, stock_status: raw.features.stock_status !== false, quick_add: raw.features.quick_add === true,
    } : { search:true,promotions:true,support:true,ratings:false,stock_status:true,quick_add:false },
  };
}

function mergeObjects(base, override) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) out[key] = mergeObjects(out[key], value);
    else out[key] = value;
  }
  return out;
}

function preserveMerchantContent(template, current) {
  const result = mergeObjects(current, template);
  result.branding = { ...(template.branding || {}), ...(current.branding || {}) };
  result.seo = { ...(template.seo || {}), ...(current.seo || {}) };
  result.features = { ...(template.features || {}), ...(current.features || {}) };
  if (Array.isArray(current?.navigation) && current.navigation.length) result.navigation = current.navigation;
  const templateSections = Array.isArray(template?.home?.sections) ? template.home.sections : [];
  const currentSections = Array.isArray(current?.home?.sections) ? current.home.sections : [];
  if (templateSections.length) {
    const used = new Set();
    result.home = { ...(template.home || {}), sections: templateSections.map((section, index) => {
      let matchIndex = currentSections.findIndex((candidate, i) => !used.has(i) && candidate?.type === section?.type);
      if (matchIndex < 0 && currentSections[index]) matchIndex = index;
      const existing = matchIndex >= 0 ? currentSections[matchIndex] : null;
      if (matchIndex >= 0) used.add(matchIndex);
      if (!existing) return section;
      return { ...section, title: existing.title ?? section.title, body: existing.body ?? section.body, image_url: existing.image_url ?? section.image_url,
        video_url: existing.video_url ?? section.video_url, poster_url: existing.poster_url ?? section.poster_url, product_ref: existing.product_ref ?? section.product_ref,
        cta_label: existing.cta_label ?? section.cta_label, cta_path: existing.cta_path ?? section.cta_path, slides: existing.slides?.length ? existing.slides : section.slides };
    }) };
  } else if (currentSections.length) result.home = { ...(result.home || {}), sections: currentSections };
  return result;
}

export async function loadExperience(db, tenantId, storeId) {
  const result = await db.query(
    `SELECT public_id,version,state,config,template_key,base_template_key,template_customized,schema_version,created_at,updated_at,published_at
       FROM storefront_experience_versions WHERE tenant_id=$1 AND store_id=$2
      ORDER BY version DESC`, [tenantId, storeId],
  );
  return {
    draft: result.rows.find((row) => row.state === 'DRAFT') || null,
    published: result.rows.find((row) => row.state === 'PUBLISHED') || null,
    history: result.rows.filter((row) => row.state !== 'DRAFT').slice(0, 20),
  };
}

export async function loadExperienceCatalog(db) {
  const [templates, typography, statusPacks] = await Promise.all([
    db.query(`SELECT public_id AS id,key,name,business_type,status,config,updated_at FROM platform_storefront_templates WHERE status='ACTIVE' ORDER BY business_type,name`),
    db.query(`SELECT key,name,category,heading_stack,body_stack,settings FROM platform_typography_presets WHERE status='ACTIVE' ORDER BY category,name`),
    db.query(`SELECT key,name,business_type,status,icons,settings FROM platform_status_visual_packs WHERE status='ACTIVE' ORDER BY business_type,name`),
  ]);
  return { templates: templates.rows, typography_presets: typography.rows, status_visual_packs: [{ key:'AUTO',name:'Automatic',business_type:'TEMPLATE',status:'ACTIVE',icons:{},settings:{} }, ...statusPacks.rows] };
}

export async function updateDraft(client, { tenantId, storeId, actorId, config, templateKey = undefined, templateCustomized = undefined }) {
  const current = await client.query(
    `SELECT id,version,template_key,base_template_key,template_customized FROM storefront_experience_versions WHERE tenant_id=$1 AND store_id=$2 AND state='DRAFT' FOR UPDATE`,
    [tenantId, storeId],
  );
  const normalized = applyTenantExperiencePolicy(normalizeExperienceConfig(config), await loadTenantExperiencePolicy(client, tenantId));
  if (current.rowCount) {
    const selectedTemplate = templateKey === undefined ? current.rows[0].template_key : templateKey;
    const baseTemplate = templateKey === undefined ? (current.rows[0].base_template_key || current.rows[0].template_key) : templateKey;
    const customized = templateCustomized === undefined ? Boolean(baseTemplate) : Boolean(templateCustomized);
    const updated = await client.query(
      `UPDATE storefront_experience_versions
          SET config=$1::jsonb,template_key=$2,base_template_key=$3,template_customized=$4,schema_version=4,created_by=$5,updated_at=now()
        WHERE id=$6
        RETURNING public_id,version,state,config,template_key,base_template_key,template_customized,schema_version,updated_at`,
      [JSON.stringify(normalized), selectedTemplate, baseTemplate, customized, actorId, current.rows[0].id],
    );
    return updated.rows[0];
  }
  const max = await client.query('SELECT COALESCE(MAX(version),0)::int AS v FROM storefront_experience_versions WHERE tenant_id=$1 AND store_id=$2', [tenantId, storeId]);
  const customized = templateCustomized === undefined ? Boolean(templateKey) : Boolean(templateCustomized);
  const inserted = await client.query(
    `INSERT INTO storefront_experience_versions(id,public_id,tenant_id,store_id,version,state,config,template_key,base_template_key,template_customized,schema_version,created_by)
     VALUES($1,$2,$3,$4,$5,'DRAFT',$6::jsonb,$7,$8,$9,4,$10)
     RETURNING public_id,version,state,config,template_key,base_template_key,template_customized,schema_version,updated_at`,
    [uuid(), publicId('sfx'), tenantId, storeId, max.rows[0].v + 1, JSON.stringify(normalized), templateKey ?? null, templateKey ?? null, customized, actorId],
  );
  return inserted.rows[0];
}

export async function applyExperienceTemplate(client, { tenantId, storeId, actorId, templateKey, mode='full', keepContent=true }) {
  const template = await client.query(`SELECT key,config FROM platform_storefront_templates WHERE key=$1 AND status='ACTIVE'`, [templateKey]);
  if (!template.rowCount) throw errors.notFound('CUSTOMER_EXPERIENCE_TEMPLATE_NOT_FOUND','Active storefront template not found');
  const loaded = await loadExperience(client, tenantId, storeId);
  const current = loaded.draft?.config || loaded.published?.config || {};
  const tpl = template.rows[0].config || {};
  let next;
  if (mode === 'layout') next = mergeObjects(current, { layout: tpl.layout || {}, responsive: tpl.responsive || {}, home: keepContent ? current.home : tpl.home || current.home });
  else if (mode === 'theme') next = mergeObjects(current, { theme: tpl.theme || {}, typography: tpl.typography || {}, status_visual_pack: tpl.status_visual_pack || 'AUTO' });
  else next = keepContent ? preserveMerchantContent(tpl, current) : mergeObjects(tpl, {});
  return updateDraft(client,{ tenantId, storeId, actorId, config:next, templateKey, templateCustomized:mode !== 'full' });
}

export async function publishDraft(client, { tenantId, storeId, actorId }) {
  const draft = await client.query(
    `SELECT * FROM storefront_experience_versions WHERE tenant_id=$1 AND store_id=$2 AND state='DRAFT' FOR UPDATE`, [tenantId, storeId],
  );
  if (!draft.rowCount) throw errors.conflict('CUSTOMER_EXPERIENCE_DRAFT_REQUIRED', 'Save a draft before publishing');
  const normalized = normalizeExperienceConfig(draft.rows[0].config);
  await client.query(`UPDATE storefront_experience_versions SET state='ARCHIVED',updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND state='PUBLISHED'`, [tenantId, storeId]);
  const published = await client.query(
    `UPDATE storefront_experience_versions SET state='PUBLISHED',config=$1::jsonb,schema_version=4,published_by=$2,published_at=now(),updated_at=now()
      WHERE id=$3 RETURNING public_id,version,state,config,template_key,base_template_key,template_customized,schema_version,published_at`, [JSON.stringify(normalized), actorId, draft.rows[0].id],
  );
  const nextVersion = draft.rows[0].version + 1;
  await client.query(
    `INSERT INTO storefront_experience_versions(id,public_id,tenant_id,store_id,version,state,config,template_key,base_template_key,template_customized,schema_version,created_by)
     VALUES($1,$2,$3,$4,$5,'DRAFT',$6::jsonb,$7,$8,$9,4,$10)`,
    [uuid(), publicId('sfx'), tenantId, storeId, nextVersion, JSON.stringify(normalized), draft.rows[0].template_key, draft.rows[0].base_template_key || draft.rows[0].template_key, draft.rows[0].template_customized, actorId],
  );
  return published.rows[0];
}

export async function rollbackExperience(client, { tenantId, storeId, actorId, version }) {
  const source = await client.query(
    `SELECT * FROM storefront_experience_versions WHERE tenant_id=$1 AND store_id=$2 AND version=$3 AND state IN ('PUBLISHED','ARCHIVED') FOR UPDATE`,
    [tenantId, storeId, version],
  );
  if (!source.rowCount) throw errors.notFound('CUSTOMER_EXPERIENCE_VERSION_NOT_FOUND', 'Published experience version not found');
  const normalized = normalizeExperienceConfig(source.rows[0].config);
  await client.query(`UPDATE storefront_experience_versions SET state='ARCHIVED',updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND state IN ('PUBLISHED','DRAFT')`, [tenantId, storeId]);
  const max = await client.query('SELECT COALESCE(MAX(version),0)::int AS v FROM storefront_experience_versions WHERE tenant_id=$1 AND store_id=$2', [tenantId, storeId]);
  const publishedVersion = max.rows[0].v + 1;
  const published = await client.query(
    `INSERT INTO storefront_experience_versions(id,public_id,tenant_id,store_id,version,state,config,template_key,base_template_key,template_customized,schema_version,published_by,published_at)
     VALUES($1,$2,$3,$4,$5,'PUBLISHED',$6::jsonb,$7,$8,$9,4,$10,now())
     RETURNING public_id,version,state,config,template_key,base_template_key,template_customized,schema_version,published_at`,
    [uuid(), publicId('sfx'), tenantId, storeId, publishedVersion, JSON.stringify(normalized), source.rows[0].template_key, source.rows[0].base_template_key || source.rows[0].template_key, source.rows[0].template_customized, actorId],
  );
  await client.query(
    `INSERT INTO storefront_experience_versions(id,public_id,tenant_id,store_id,version,state,config,template_key,base_template_key,template_customized,schema_version,created_by)
     VALUES($1,$2,$3,$4,$5,'DRAFT',$6::jsonb,$7,$8,$9,4,$10)`,
    [uuid(), publicId('sfx'), tenantId, storeId, publishedVersion + 1, JSON.stringify(normalized), source.rows[0].template_key, source.rows[0].base_template_key || source.rows[0].template_key, source.rows[0].template_customized, actorId],
  );
  return published.rows[0];
}
