import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const value = (name: string, fallback: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1] || fallback; };
const database = resolve(value('--db', 'data/skillgraph.sqlite'));
const repository = value('--repository', 'anthropics/skills');
let commands = 0;
function cli(command: string[], expectedError?: string): any {
  commands++;
  const result = spawnSync(process.execPath, ['src/cli.ts', ...command, '--db', database], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32_000_000 });
  if (result.error) throw result.error;
  if (expectedError) {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    // Node's experimental SQLite warning follows the structured CLI error.
    const error = JSON.parse(result.stderr.split(/\r?\n/).find(line => line.startsWith('{'))!);
    assert.equal(error.error, expectedError);
    return error;
  }
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const stats = cli(['stats']);
assert.ok(stats.skills > 0, 'Import a corpus before running this check.');
const scope = ['--repository', repository];
const collect = (format: string) => {
  const rows: any[][] = [];
  let offset = 0, digest = '';
  do {
    const page = cli(['catalog', ...scope, '--format', format, '--offset', String(offset), '--maxTokens', '8000', ...(digest ? ['--catalogHash', digest] : [])]);
    if (digest) assert.equal(page.catalogHash, digest);
    digest = page.catalogHash;
    const parsed = page.text.trimEnd().split('\n').slice(1).map((line: string) => JSON.parse(line));
    assert.equal(parsed.length, page.returned);
    assert.equal(page.offset, rows.length);
    rows.push(...parsed);
    if (page.nextOffset === null) { assert.equal(rows.length, page.total); break; }
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  } while (true);
  assert.ok(rows.length > 0, 'The declared repository must contain skills.');
  return { rows, digest };
};
const compact = collect('compact'), full = collect('full');
assert.equal(compact.digest, full.digest);
assert.equal(compact.rows.length, full.rows.length);
for (let i = 0; i < compact.rows.length; i++) {
  assert.deepEqual(compact.rows[i].slice(1, 4), full.rows[i].slice(1, 4));
  assert.deepEqual(compact.rows[i][4], full.rows[i][5]);
}
const selected = compact.rows.at(-1)!;
const metadata = cli(['resolve', ...scope, '--handle', selected[0], '--catalogHash', compact.digest]);
assert.equal(metadata.id, full.rows.at(-1)![0]);
const inspected = cli(['inspect', '--file', metadata.id]);
assert.equal(inspected.hash, metadata.hash);
const source = cli(['read', '--file', metadata.id, '--start', '1', '--end', String(metadata.totalLines), '--hash', metadata.hash]);
assert.equal(createHash('sha256').update(source.text).digest('hex'), metadata.hash);
const numbered = cli(['read', '--file', metadata.id, '--start', String(metadata.totalLines), '--end', String(metadata.totalLines), '--hash', metadata.hash, '--numbered']);
assert.equal(numbered.startLine, metadata.totalLines);
assert.ok(numbered.numberedText.includes(String(metadata.totalLines)));
const files = cli(['files', ...scope, '--package', metadata.packagePath]);
assert.ok(files.items.some((file: any) => file.id === metadata.id));
cli(['resolve', ...scope, '--handle', selected[0], '--catalogHash', 'stale'], 'STALE_CATALOG');
cli(['read', '--file', metadata.id, '--end', '1', '--hash', 'stale'], 'STALE_CITATION');
const report = { checkedAt: new Date().toISOString(), status: 'passed', repository, catalogOccurrences: compact.rows.length, commands, selected: { path: metadata.path, hash: metadata.hash, totalLines: metadata.totalLines }, checks: ['complete compact/full catalog equivalence', 'snapshot-bound resolution', 'inspect', 'whole-source SHA-256', 'numbered final line', 'package inventory', 'stale catalog rejection', 'stale source rejection'], classification: 'Real CLI subprocess and corpus test; no model inference.' };
mkdirSync('reports/retest', { recursive: true });
writeFileSync('reports/retest/cli-smoke.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
