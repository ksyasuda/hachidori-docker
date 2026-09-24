import fs from 'node:fs';
import path from 'node:path';
const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: npm run import -- /path/to/dictionary.zip [...]');
// Defaults to the management listener this process's environment configures,
// which inside the container matches the running server.
const bind = process.env.LISTEN_ADDRESS;
const address = !bind || bind === '0.0.0.0' ? '127.0.0.1' : bind.includes(':') ? `[${bind}]` : bind;
const host = process.env.HOST_URL ?? `http://${address}:${process.env.ADMIN_PORT ?? 8780}`;
for (const file of files) {
  const url = new URL('/import', host);
  url.searchParams.set('name', path.basename(file));
  const response = await fetch(url, { method: 'POST', body: fs.createReadStream(file), duplex: 'half', signal: AbortSignal.timeout(15 * 60_000) });
  const result = await response.json();
  if (!response.ok || !result.ok || !result.report?.success) throw new Error(JSON.stringify(result));
  process.stdout.write(`${JSON.stringify({ file, report: result.report })}\n`);
}
