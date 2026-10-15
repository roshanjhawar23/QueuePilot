#!/usr/bin/env node
// Submits a burst of REAL jobs to the deployed API so you can watch the queue absorb load.
// Usage (PowerShell):
//   $env:QP_API_URL = "https://xxxx.execute-api.us-east-1.amazonaws.com"
//   $env:QP_TOKEN   = "<demo token>"
//   node scripts/burst.mjs 50
// Hard limit: 200 jobs per run (cost control). Cost of 200 jobs: well under one US cent.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX = 200;
const count = Number(process.argv[2] ?? 20);
const api = (process.env.QP_API_URL ?? '').replace(/\/+$/, '');
const token = process.env.QP_TOKEN ?? '';

if (!api || !token) {
  console.error('Set QP_API_URL and QP_TOKEN first (see the comment at the top of this file).');
  process.exit(1);
}
if (!Number.isInteger(count) || count < 1 || count > MAX) {
  console.error(`Count must be a whole number from 1 to ${MAX}.`);
  process.exit(1);
}

const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const file = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sample-data', 'sales.csv'));

// One upload, many jobs: every job processes the same real file.
const up = await fetch(`${api}/uploads`, { method: 'POST', headers, body: JSON.stringify({ fileName: 'sales.csv', sizeBytes: file.length }) });
if (!up.ok) {
  console.error('Upload request failed:', up.status, await up.text());
  process.exit(1);
}
const upload = await up.json();
const form = new FormData();
for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
form.append('file', new Blob([file]));
const s3 = await fetch(upload.url, { method: 'POST', body: form });
if (s3.status !== 204) {
  console.error('S3 upload failed:', s3.status, await s3.text());
  process.exit(1);
}

let ok = 0;
let failed = 0;
const started = Date.now();
// Submit in small parallel groups to stay under the API throttle (10 requests/second).
for (let i = 0; i < count; i += 5) {
  const group = Array.from({ length: Math.min(5, count - i) }, () =>
    fetch(`${api}/jobs`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ type: 'csv.summary', inputKey: upload.inputKey }),
    }).then((r) => (r.status === 202 ? ok++ : failed++)),
  );
  await Promise.all(group);
  await new Promise((r) => setTimeout(r, 600));
}
console.log(`Submitted ${ok} job(s) in ${((Date.now() - started) / 1000).toFixed(1)} s; ${failed} request(s) failed.`);
console.log('Watch the Dashboard page and the CloudWatch dashboard: queue depth rises, then drains with at most 3 workers.');
