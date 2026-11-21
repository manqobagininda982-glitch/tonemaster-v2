#!/usr/bin/env node
// OWNER TOOL – issue a device-bound licence after you have received payment (R250) and the customer's Device ID.
//   node tools/issue-licence.js --device TM-XXXX-XXXX-XXXX-XXXX --customer "Name" [--role owner] [--key owner-keys/private.pem] [--replaces LID]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const a = {}; for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!/^TM-([0-9A-Z]{4}-){3}[0-9A-Z]{4}$/.test(a.device || '')) { console.error('Usage: node tools/issue-licence.js --device TM-XXXX-XXXX-XXXX-XXXX --customer "Name" [--role customer|owner] [--replaces OLD_LID]'); process.exit(1); }
const keyPath = a.key || path.join(__dirname, '..', 'owner-keys', 'private.pem');
const priv = crypto.createPrivateKey(fs.readFileSync(keyPath));
const payload = { v: 1, product: 'ToneMaster', lid: 'L' + crypto.randomBytes(6).toString('hex').toUpperCase(), customer: a.customer || 'Customer', device: a.device, role: a.role === 'owner' ? 'owner' : 'customer', issued: new Date().toISOString() };
if (a.replaces) payload.replaces = a.replaces;
const body = Buffer.from(JSON.stringify(payload));
const code = 'TM1.' + body.toString('base64url') + '.' + crypto.sign(null, body, priv).toString('base64url');
const logFile = path.join(path.dirname(keyPath), 'issued-licences.log'); fs.appendFileSync(logFile, JSON.stringify(payload) + '\n');
console.log(code);
