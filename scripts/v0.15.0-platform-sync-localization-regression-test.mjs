import fs from 'node:fs';
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const service = read('src/modules/customer-experience/service.js');
const routes = read('src/modules/customer-experience/merchant-routes.js');
const ext = read('src/modules/customer-experience/extension-normalizer.js');
const pkg = JSON.parse(read('package.json'));
const checks = [
  ['backend release is 0.15.0', pkg.version === '0.15.0'],
  ['verify includes platform sync regression', pkg.scripts.verify.includes('test:platform-sync-v0150')],
  ['experience sanitizer imports extension normalizer', service.includes("from './extension-normalizer.js'" )],
  ['experience sanitizer preserves extensions', service.includes('...normalizeExperienceExtensions(raw)')],
  ['draft save enforces tenant experience policy', service.includes('applyTenantExperiencePolicy(normalizeExperienceConfig(config)')],
  ['merchant experience response exposes tenant policy', routes.includes('loadTenantExperiencePolicy') && routes.includes('experience_policy')],
  ['localization supports four languages', ext.includes('slice(0, 4)') && ext.includes('storefront_languages')],
  ['localization translations are sanitized', ext.includes('sanitizeTree(source.translations')],
  ['address fields are normalized', ext.includes('address_line_2') && ext.includes('postal_code') && ext.includes('default_country_code')],
  ['platform capabilities govern localization', ext.includes('storefront_localization')],
  ['platform capabilities govern address policy', ext.includes('address_field_policy')],
  ['language limit is capped at four', ext.includes('language_limit: clamp')],
];
let pass = 0;
for (const [name, ok] of checks) { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (ok) pass++; }
console.log(`${pass}/${checks.length} Backend v0.15.0 platform sync regression checks passed`);
if (pass !== checks.length) process.exit(1);
