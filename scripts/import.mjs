import fs from 'node:fs';
import path from 'node:path';
const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: npm run import -- /path/to/dictionary.zip [...]');
const host = process.env.HOST_URL ?? 'http://127.0.0.1:8780';
for (const file of files) {
  const url = new URL('/import', host);
  url.searchParams.set('name', path.basename(file));
  const response = await fetch(url, { method: 'POST', body: fs.createReadStream(file), duplex: 'half', signal: AbortSignal.timeout(15 * 60_000) });
  const result = await response.json();
  if (!response.ok || !result.ok || !result.report?.success) throw new Error(JSON.stringify(result));
  process.stdout.write(`${JSON.stringify({ file, report: result.report })}\n`);
}
