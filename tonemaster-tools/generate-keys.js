#!/usr/bin/env node
// OWNER TOOL – run on YOUR computer only. Creates your Ed25519 licence-signing key pair.
//   node tools/generate-keys.js
// Writes  owner-keys/private.pem  (KEEP SECRET, never ship it)  and updates js/config.js with the PUBLIC key.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..'), dir = path.join(root, 'owner-keys');
if (fs.existsSync(path.join(dir, 'private.pem')) && !process.argv.includes('--force')) { console.error('owner-keys/private.pem already exists. Use --force ONLY if you accept that all previously issued licences stop working.'); process.exit(1); }
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'private.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
const cfgPath = path.join(root, 'public', 'tonemaster', 'js', 'config.js'); let cfg = fs.readFileSync(cfgPath, 'utf8');
cfg = cfg.replace(/PUBLIC_KEY: '[^']*'/, "PUBLIC_KEY: '" + pub + "'"); fs.writeFileSync(cfgPath, cfg);
try { (await import('node:child_process')).execFileSync(process.execPath, [path.join(__dirname, 'build-bundle.js')], { stdio: 'inherit' }); } catch (e) { console.error('Run: node tools/build-bundle.js'); }
console.log('Public key written to js/config.js:\n  ' + pub + '\nPrivate key saved to owner-keys/private.pem  — back it up OFFLINE and never upload it.\nRebuild/redeploy the app so it contains the new public key.');
