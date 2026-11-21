#!/usr/bin/env node
// OWNER TOOL – make a batch of pre-made licence keys to hand out after each sale (no database needed).
//   node tools/issue-batch.js --count 500 --prefix B1 [--key owner-keys/private.pem]
// Writes owner-keys/batches/<prefix>-keys.csv (your sales ledger: fill in sold_to / date) and <prefix>-keys.txt.
// Each key is signed, unique, and binds to the first phone that activates it. Customer keys never show the Owner/admin tab.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const a = {}; for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const count = parseInt(a.count || '500', 10), prefix = (a.prefix || 'B1').replace(/[^A-Za-z0-9]/g, '');
const keyPath = a.key || path.join(__dirname, '..', 'owner-keys', 'private.pem'), priv = crypto.createPrivateKey(fs.readFileSync(keyPath));
const dir = path.join(path.dirname(keyPath), 'batches'); fs.mkdirSync(dir, { recursive: true });
const csv = path.join(dir, prefix + '-keys.csv'); if (fs.existsSync(csv)) { console.error(csv + ' exists. Use a new --prefix (never reissue the same IDs).'); process.exit(1); }
let rows = ['licence_id,key,sold_to,date_sold,notes'], txt = [];
for (let i = 1; i <= count; i++) { const lid = prefix + '-' + String(i).padStart(4, '0'); const key = 'TM2.' + Buffer.from(lid).toString('base64url') + '.' + crypto.sign(null, Buffer.from('ToneMaster|batch|' + lid), priv).toString('base64url'); rows.push(lid + ',' + key + ',,,'); txt.push(lid + '  ' + key); }
fs.writeFileSync(csv, rows.join('\n') + '\n'); fs.writeFileSync(path.join(dir, prefix + '-keys.txt'), txt.join('\n') + '\n'); console.log('Wrote ' + count + ' keys to ' + csv);
