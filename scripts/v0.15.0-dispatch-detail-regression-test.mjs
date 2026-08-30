import fs from'node:fs';import assert from'node:assert/strict';
const source=fs.readFileSync('src/modules/delivery/operations-routes.js','utf8').replace(/\r\n?/g,'\n');
const detail=source.match(/app\.get\('\/v1\/merchant\/delivery\/dispatches\/:dispatchId'[\s\S]*?\n \}\);/);
assert.ok(detail,'Merchant dispatch detail route must exist');
const route=detail[0];
assert.match(route,/SELECT e\.event_type,e\.actor_type,e\.from_status,e\.to_status,e\.reason,e\.metadata,e\.created_at FROM delivery_dispatch_events e JOIN delivery_dispatches x/,'Dispatch event query must qualify every selected event column');
assert.doesNotMatch(route,/SELECT event_type,actor_type,from_status,to_status,reason,metadata,created_at FROM delivery_dispatch_events e/,'Dispatch detail must never use ambiguous unqualified columns across the event/dispatch join');
assert.match(route,/ORDER BY e\.created_at,e\.id/,'Dispatch event history must remain deterministically ordered');
console.log('PASS dispatch detail event query uses qualified SQL columns');
