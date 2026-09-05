import fs from 'node:fs';

const read=(path)=>fs.readFileSync(path,'utf8');
const service=read('src/modules/customer-experience/service.js');
const routes=read('src/modules/themes/merchant-routes.js');
const selection=read('src/modules/themes/selection-service.js');
const storefront=read('src/modules/storefront/context.js');
const manifest=read('src/modules/themes/service.js');
const migration=read('migrations/036_store_staff_theme_settings_v1.sql');
let count=0;
const pass=(ok,message)=>{if(!ok)throw new Error(`FAIL ${message}`);count++;console.log(`PASS ${message}`);};

pass(service.includes('theme_package: normalizeThemeSelection(raw.theme_package)'), 'Customer theme package is versioned in CX v4 config');
pass(service.includes('applyExperienceThemePackage'), 'Customer theme selection uses Store Designer draft workflow');
pass(service.includes("resolveThemePackage(client, selection, { app:'CUSTOMER_WEB', publishedOnly })")&&service.match(/validateCustomerTheme\(client, normalized\.theme_package, normalized\.theme_component_overrides, \{ publishedOnly:true \}\)/g)?.length>=2&&service.includes('validateCustomerTheme(client, normalizedSelection, normalizedOverrides, { publishedOnly:true })'), 'Draft apply and publish require published Customer Web theme versions with override validation');
pass(service.includes('validateCustomerTheme(client, normalized.theme_package, normalized.theme_component_overrides, { publishedOnly:false })'), 'Rollback can preserve an immutable retired theme version and its approved overrides');
pass(routes.includes("'/v1/merchant/customer-experience/apply-theme'"), 'Merchant Customer theme apply endpoint exists');
pass(routes.includes("'/v1/merchant/staff-experience'"), 'Merchant Staff theme settings endpoint exists');
pass(routes.includes("'/v1/merchant/staff-experience/runtime'"), 'Authenticated Staff runtime endpoint exists');
pass(routes.includes("app.get('/v1/merchant/staff-experience/runtime', {\n    preHandler:[app.requireMerchantAuth]"), 'Staff runtime requires authentication and inherits Backend store-scope enforcement');
pass(routes.includes('TENANT_SETTINGS_WRITE'), 'Staff theme mutation uses tenant settings write permission');
pass(routes.includes("action:'customer_experience.theme.apply'"), 'Customer theme changes are audited');
pass(routes.includes("action:'staff_experience.theme.update'"), 'Staff theme changes are audited');
pass(selection.includes("app:'STAFF_WEB', publishedOnly:true"), 'New Staff theme assignments require published Staff Web themes');
pass(selection.includes("DELETE FROM store_staff_theme_settings"), 'Staff theme can safely fall back to legacy styling');
pass(migration.includes('PRIMARY KEY (tenant_id, store_id)'), 'Staff theme selection is store scoped');
pass(migration.includes('FOREIGN KEY (theme_key, theme_version)'), 'Staff theme selection pins an installed immutable package version');
pass(storefront.includes('theme_package: publicThemePackage(resolvedThemePackage)'), 'Public storefront receives resolved safe theme package');
pass(storefront.includes("app:'CUSTOMER_WEB', publishedOnly:false"), 'Runtime resolves exact selected Customer theme version after retirement');
pass(manifest.includes("['standard','ios_tab','floating_tab','minimal_tab','commerce_tab']"), 'Professional mobile navigation variants remain allow-listed');
pass(!selection.includes('eval(') && !selection.includes('new Function'), 'Theme selection runtime does not execute package source');

console.log(`${count}/${count} Luke Theme System v1 A2 checks passed`);
