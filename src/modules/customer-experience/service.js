import { errors } from '../../core/errors.js';
import { publicId, uuid } from '../../core/identifiers.js';

const NAV = new Set(['home','explore','cart','orders','profile']);
const SECTION_TYPES = new Set(['announcement_bar','hero','hero_slider','categories','featured_products','promotion_banner','new_arrivals']);
const COLOR = /^#[0-9a-fA-F]{6}$/;
const text = (value, max = 500) => String(value ?? '').slice(0, max);
const color = (value, fallback) => COLOR.test(String(value || '')) ? String(value) : fallback;
const oneOf = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;

const THEME_DEFAULT = Object.freeze({
  preset:'modern', primary:'#166534', secondary:'#111827', accent:'#14b8a6', background:'#f8fafc', surface:'#ffffff', text:'#172033', muted_text:'#667085', success:'#15803d', danger:'#b42318',
  radius:'medium', card_style:'clean', button_style:'solid', density:'comfortable',
});
const TYPOGRAPHY_DEFAULT = Object.freeze({preset:'SYSTEM_MINIMAL',heading_scale:'normal',body_scale:'normal',letter_spacing:'normal',button_case:'none'});
const LAYOUT_DEFAULT = Object.freeze({header:'logo_left',hero:'split',categories:'cards',product_grid:'four',product_card:'standard',mobile_nav:'standard'});

export function normalizeExperienceConfig(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const theme = raw.theme && typeof raw.theme === 'object' ? raw.theme : {};
  const typography = raw.typography && typeof raw.typography === 'object' ? raw.typography : {};
  const layout = raw.layout && typeof raw.layout === 'object' ? raw.layout : {};
  const branding = raw.branding && typeof raw.branding === 'object' ? raw.branding : {};
  const home = raw.home && typeof raw.home === 'object' ? raw.home : {};
  const sections = Array.isArray(home.sections) ? home.sections.slice(0, 24).map((section, index) => {
    const type = SECTION_TYPES.has(section?.type) ? section.type : null;
    if (!type) return null;
    return {
      id: text(section.id || `${type}-${index + 1}`, 80), type, enabled: section.enabled !== false,
      title: text(section.title, 180), body: text(section.body, 800), image_url: text(section.image_url, 1500),
      cta_label: text(section.cta_label, 80), cta_path: text(section.cta_path, 200), limit: Math.max(1, Math.min(Number(section.limit || 8), 24)),
    };
  }).filter(Boolean) : [];
  const navigation = Array.isArray(raw.navigation) ? raw.navigation.filter((item) => NAV.has(item)).slice(0, 5) : ['home','explore','cart','orders','profile'];
  return {
    schema_version: 2,
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
      store_name: text(branding.store_name, 120), announcement: text(branding.announcement, 240), hero_title: text(branding.hero_title, 180),
      hero_subtitle: text(branding.hero_subtitle, 500), logo_url: text(branding.logo_url, 1500), favicon_url: text(branding.favicon_url,1500),
    },
    navigation: navigation.length ? [...new Set(navigation)] : ['home','explore','cart','orders','profile'],
    home: { sections: sections.length ? sections : [
      { id:'hero',type:'hero',enabled:true,title:'',body:'',image_url:'',cta_label:'',cta_path:'',limit:8 },
      { id:'categories',type:'categories',enabled:true,title:'',body:'',image_url:'',cta_label:'',cta_path:'',limit:8 },
      { id:'featured',type:'featured_products',enabled:true,title:'',body:'',image_url:'',cta_label:'',cta_path:'',limit:8 },
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
  // Template design tokens and layout win; merchant-authored copy/media and commerce feature choices survive.
  const result = mergeObjects(current, template);
  result.branding = { ...(template.branding || {}), ...(current.branding || {}) };
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
      return { ...section, title: existing.title ?? section.title, body: existing.body ?? section.body, image_url: existing.image_url ?? section.image_url, cta_label: existing.cta_label ?? section.cta_label, cta_path: existing.cta_path ?? section.cta_path };
    }) };
  } else if (currentSections.length) result.home = { ...(result.home || {}), sections: currentSections };
  return result;
}

export async function loadExperience(db, tenantId, storeId) {
  const result = await db.query(
    `SELECT public_id,version,state,config,template_key,schema_version,created_at,updated_at,published_at
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
  const [templates, typography] = await Promise.all([
    db.query(`SELECT public_id AS id,key,name,business_type,status,config,updated_at FROM platform_storefront_templates WHERE status='ACTIVE' ORDER BY business_type,name`),
    db.query(`SELECT key,name,category,heading_stack,body_stack,settings FROM platform_typography_presets WHERE status='ACTIVE' ORDER BY category,name`),
  ]);
  return { templates: templates.rows, typography_presets: typography.rows };
}

export async function updateDraft(client, { tenantId, storeId, actorId, config, templateKey = undefined }) {
  const current = await client.query(
    `SELECT id,version,template_key FROM storefront_experience_versions WHERE tenant_id=$1 AND store_id=$2 AND state='DRAFT' FOR UPDATE`,
    [tenantId, storeId],
  );
  const normalized = normalizeExperienceConfig(config);
  if (current.rowCount) {
    const selectedTemplate = templateKey === undefined ? current.rows[0].template_key : templateKey;
    const updated = await client.query(
      `UPDATE storefront_experience_versions SET config=$1::jsonb,template_key=$2,schema_version=2,created_by=$3,updated_at=now()
        WHERE id=$4 RETURNING public_id,version,state,config,template_key,schema_version,updated_at`,
      [JSON.stringify(normalized), selectedTemplate, actorId, current.rows[0].id],
    );
    return updated.rows[0];
  }
  const max = await client.query('SELECT COALESCE(MAX(version),0)::int AS v FROM storefront_experience_versions WHERE tenant_id=$1 AND store_id=$2', [tenantId, storeId]);
  const inserted = await client.query(
    `INSERT INTO storefront_experience_versions(id,public_id,tenant_id,store_id,version,state,config,template_key,schema_version,created_by)
     VALUES($1,$2,$3,$4,$5,'DRAFT',$6::jsonb,$7,2,$8) RETURNING public_id,version,state,config,template_key,schema_version,updated_at`,
    [uuid(), publicId('sfx'), tenantId, storeId, max.rows[0].v + 1, JSON.stringify(normalized), templateKey ?? null, actorId],
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
  if (mode === 'layout') next = mergeObjects(current, { layout: tpl.layout || {}, home: keepContent ? current.home : tpl.home || current.home });
  else if (mode === 'theme') next = mergeObjects(current, { theme: tpl.theme || {}, typography: tpl.typography || {} });
  else next = keepContent ? preserveMerchantContent(tpl, current) : mergeObjects(tpl, {});
  return updateDraft(client,{tenantId,storeId,actorId,config:next,templateKey:templateKey});
}

export async function publishDraft(client, { tenantId, storeId, actorId }) {
  const draft = await client.query(
    `SELECT * FROM storefront_experience_versions WHERE tenant_id=$1 AND store_id=$2 AND state='DRAFT' FOR UPDATE`, [tenantId, storeId],
  );
  if (!draft.rowCount) throw errors.conflict('CUSTOMER_EXPERIENCE_DRAFT_REQUIRED', 'Save a draft before publishing');
  const normalized = normalizeExperienceConfig(draft.rows[0].config);
  await client.query(`UPDATE storefront_experience_versions SET state='ARCHIVED',updated_at=now() WHERE tenant_id=$1 AND store_id=$2 AND state='PUBLISHED'`, [tenantId, storeId]);
  const published = await client.query(
    `UPDATE storefront_experience_versions SET state='PUBLISHED',config=$1::jsonb,schema_version=2,published_by=$2,published_at=now(),updated_at=now()
      WHERE id=$3 RETURNING public_id,version,state,config,template_key,schema_version,published_at`, [JSON.stringify(normalized), actorId, draft.rows[0].id],
  );
  const nextVersion = draft.rows[0].version + 1;
  await client.query(
    `INSERT INTO storefront_experience_versions(id,public_id,tenant_id,store_id,version,state,config,template_key,schema_version,created_by)
     VALUES($1,$2,$3,$4,$5,'DRAFT',$6::jsonb,$7,2,$8)`,
    [uuid(), publicId('sfx'), tenantId, storeId, nextVersion, JSON.stringify(normalized), draft.rows[0].template_key, actorId],
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
    `INSERT INTO storefront_experience_versions(id,public_id,tenant_id,store_id,version,state,config,template_key,schema_version,published_by,published_at)
     VALUES($1,$2,$3,$4,$5,'PUBLISHED',$6::jsonb,$7,2,$8,now()) RETURNING public_id,version,state,config,template_key,schema_version,published_at`,
    [uuid(), publicId('sfx'), tenantId, storeId, publishedVersion, JSON.stringify(normalized), source.rows[0].template_key, actorId],
  );
  await client.query(
    `INSERT INTO storefront_experience_versions(id,public_id,tenant_id,store_id,version,state,config,template_key,schema_version,created_by)
     VALUES($1,$2,$3,$4,$5,'DRAFT',$6::jsonb,$7,2,$8)`,
    [uuid(), publicId('sfx'), tenantId, storeId, publishedVersion + 1, JSON.stringify(normalized), source.rows[0].template_key, actorId],
  );
  return published.rows[0];
}
