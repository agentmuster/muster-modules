// Links @agentmuster/module-sdk into node_modules. Muster provides the SDK to installed modules at run time, and it is
// not on npm yet, so development here uses Muster's copy: MUSTER_DIR if set, else a shallow clone in .muster/.
import {execFileSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, rmSync, symlinkSync} from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
let muster = process.env.MUSTER_DIR && path.resolve(process.env.MUSTER_DIR);
if (!muster) {
  muster = path.join(root, '.muster');
  if (!existsSync(path.join(muster, '.git'))) {
    execFileSync('git', ['clone', '--quiet', '--depth', '1', 'https://github.com/rampradeep84/muster', muster], {stdio: 'inherit'});
  } else {
    execFileSync('git', ['-C', muster, 'pull', '--quiet', '--ff-only'], {stdio: 'inherit'});
  }
}
const sdk = path.join(muster, 'packages', 'module-sdk');
if (!existsSync(path.join(sdk, 'index.ts'))) throw new Error(`No module SDK at ${sdk}. Set MUSTER_DIR to a Muster checkout.`);
const link = path.join(root, 'node_modules', '@agentmuster', 'module-sdk');
mkdirSync(path.dirname(link), {recursive: true});
try {
  lstatSync(link);
  rmSync(link, {recursive: true, force: true});
} catch {
  // Not linked yet.
}
symlinkSync(sdk, link, 'dir');
console.log(`@agentmuster/module-sdk → ${sdk}`);
