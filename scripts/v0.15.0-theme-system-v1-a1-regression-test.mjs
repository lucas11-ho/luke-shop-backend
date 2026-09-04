import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeThemeManifest, normalizeThemePackageInput } from '../src/modules/themes/service.js';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const migration = read('migrations/035_platform_theme_packages_v1.sql');
const service = read('src/modules/themes/service.js');
const platformRoutes = read('src/modules/themes/platform-routes.js');
const merchantRoutes = read('src/modules/themes/merchant-routes.js');
const app = read('src/app.js');

assert.match(migration, /CREATE TABLE IF NOT EXISTS platform_theme_packages/);
assert.match(migration, /UNIQUE\(key,version\)/);
assert.match(migration, /status IN \('DRAFT','PUBLISHED','RETIRED'\)/);
assert.match(migration, /created_by uuid REFERENCES platform_users\(id\)/);
assert.match(migration, /published_by uuid REFERENCES platform_users\(id\)/);
assert.match(migration, /platform_theme_packages_version_check/);
assert.doesNotMatch(migration, /ALTER TABLE\s+(?:orders|payments|customers|vip_|delivery|merchant_users)/i);

assert.match(service, /CUSTOMER_WEB/);
assert.match(service, /STAFF_WEB/);
assert.match(service, /THEME_PACKAGE_EXECUTABLE_CONTENT_FORBIDDEN/);
assert.match(service, /schema_version:\s*1/);
assert.match(service, /foundations:/);
assert.match(service, /typography:/);
assert.match(service, /icons:/);
assert.match(service, /buttons:/);
assert.match(service, /navigation:/);
assert.match(service, /components:/);
assert.match(service, /publishedOnly/);
assert.doesNotMatch(service, /\beval\s*\(|new\s+Function\s*\(/);

assert.match(platformRoutes, /\/v1\/platform\/themes/);
assert.match(platformRoutes, /\/v1\/platform\/themes\/install/);
assert.match(platformRoutes, /requirePlatformOwner/);
assert.match(platformRoutes, /theme\.package\.install/);
assert.match(platformRoutes, /theme\.package\.publish/);
assert.match(platformRoutes, /theme\.package\.retire/);
assert.match(platformRoutes, /THEME_PACKAGE_IMMUTABLE/);
assert.doesNotMatch(platformRoutes, /app\.patch\('\/v1\/platform\/themes/);

assert.match(merchantRoutes, /\/v1\/merchant\/customer-experience\/theme-catalog/);
assert.match(merchantRoutes, /CUSTOMER_EXPERIENCE_READ/);
assert.match(merchantRoutes, /publishedOnly:true,app:'CUSTOMER_WEB'/);
assert.match(merchantRoutes, /\/v1\/merchant\/staff-experience\/theme-catalog/);
assert.match(merchantRoutes, /TENANT_SETTINGS_READ/);
assert.match(merchantRoutes, /publishedOnly:true,app:'STAFF_WEB'/);

assert.match(app, /platformThemeRoutes/);
assert.match(app, /merchantThemeRoutes/);
assert.match(app, /await app\.register\(platformThemeRoutes\)/);
assert.match(app, /await app\.register\(merchantThemeRoutes\)/);

const manifest = normalizeThemeManifest({
  schema_version: 1,
  foundations: { colors: { primary:'#0a84ff', background:'#ffffff', text:'#111111' }, radius:'large', density:'comfortable', elevation:'soft', motion:'standard' },
  typography: { preset:'SYSTEM_MINIMAL', scale:'standard' },
  icons: { pack:'LUKE_OUTLINE', active_style:'filled', inactive_style:'outline', size:24 },
  buttons: { primary:'ios_filled', secondary:'soft', tertiary:'ghost', destructive:'solid', icon:'round', size:'standard' },
  navigation: { mobile:'ios_tab', desktop:'header', labels:'always', active_indicator:'filled_icon', container:'edge' },
  components: { product_card:'commerce_clean', profile_card:'grouped' },
});
assert.equal(manifest.schema_version, 1);
assert.equal(manifest.navigation.mobile, 'ios_tab');
assert.equal(manifest.icons.size, 24);
assert.equal(manifest.components.product_card, 'commerce_clean');

const pkg = normalizeThemePackageInput({
  key:'LUKE_COMMERCE_IOS', version:'1.0.0', name:'Luke Commerce iOS', supported_apps:['CUSTOMER_WEB'], manifest,
  preview:{figma_url:'https://www.figma.com/design/example',thumbnail_url:'https://example.com/theme.png'},
});
assert.deepEqual(pkg.supported_apps, ['CUSTOMER_WEB']);
assert.equal(pkg.key, 'LUKE_COMMERCE_IOS');
assert.equal(pkg.version, '1.0.0');

assert.throws(() => normalizeThemeManifest({schema_version:1,css:'body{display:none}'}), /cannot contain executable or raw presentation content/i);
assert.throws(() => normalizeThemeManifest({schema_version:1,components:{card:{html:'<b>x</b>'}}}), /cannot contain executable or raw presentation content/i);
assert.throws(() => normalizeThemePackageInput({key:'BAD',version:'v1',name:'Bad Theme',supported_apps:['CUSTOMER_WEB'],manifest:{schema_version:1}}), /semantic versioning/i);
assert.throws(() => normalizeThemePackageInput({key:'GOOD_THEME',version:'1.0.0',name:'Good Theme',supported_apps:['UNKNOWN_APP'],manifest:{schema_version:1}}), /must support Customer Web and\/or Staff Web/i);

console.log('PASS Theme System v1 A1 provides immutable platform-installed theme manifests with safe Customer Web and Staff Web catalogs and no executable theme content');
