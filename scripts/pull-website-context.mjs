/**
 * Optional helper: pull the live site's llms.txt into context/website-snapshot.md
 * as a reference when updating the context/*.md knowledge files.
 *
 * The Worker NEVER reads the website at runtime - the bundled context files are
 * the source of truth, which keeps this project portable. Run this only when you
 * want fresh source material to edit them with:
 *
 *   pnpm context:pull
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SOURCE = process.env.CONTEXT_SOURCE_URL || 'https://centrisec.com/llms.txt';
const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'context', 'website-snapshot.md');

const res = await fetch(SOURCE);
if (!res.ok) {
  console.error(`Failed to fetch ${SOURCE}: HTTP ${res.status}`);
  process.exit(1);
}
const text = await res.text();

const snapshot = [
  '# Website snapshot (reference only)',
  '',
  `> Pulled from ${SOURCE} on ${new Date().toISOString()}.`,
  '> This file is NOT read by the Worker. Use it as source material when editing',
  '> company.md / services.md / segments.md, then redeploy.',
  '',
  '---',
  '',
  text.trim(),
  '',
].join('\n');

await writeFile(target, snapshot, 'utf8');
console.log(`Wrote ${target} (${snapshot.length} bytes)`);
