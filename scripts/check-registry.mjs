// Checks that registry.json lists every module in packages/ with the id, name and version of its manifest.
import {readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const registry = JSON.parse(readFileSync(path.join(root, 'registry.json'), 'utf8'));
const problems = [];
if (registry.format !== 1 || !Array.isArray(registry.modules)) problems.push('registry.json must have format 1 and a modules list');
const listed = new Map((registry.modules ?? []).map(entry => [entry.id, entry]));
for (const name of readdirSync(path.join(root, 'packages'))) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(root, 'packages', name, 'muster-module.json'), 'utf8'));
  } catch {
    continue;
  }
  const entry = listed.get(manifest.id);
  if (!entry) problems.push(`${manifest.id} is not in registry.json`);
  else {
    if (entry.path !== `packages/${name}`) problems.push(`${manifest.id}: path should be packages/${name}`);
    if (entry.version !== manifest.version) problems.push(`${manifest.id}: registry version ${entry.version}, manifest ${manifest.version}`);
    if (entry.name !== manifest.name) problems.push(`${manifest.id}: registry name differs from the manifest`);
    listed.delete(manifest.id);
  }
  if (manifest.id !== name) problems.push(`packages/${name}: folder name should match the id ${manifest.id}`);
}
for (const id of listed.keys()) problems.push(`${id} is in registry.json but not in packages/`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`registry.json lists all ${registry.modules.length} modules.`);
