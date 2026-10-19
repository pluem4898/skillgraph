import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { SkillStore } from '../src/core.ts';

test('HTTP discovery, immutable source reads, compact resolution and explicit failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skillgraph-http-'));
  const database = join(dir, 'test.sqlite');
  const store = new SkillStore(database);
  const source = '---\r\nname: http-test\r\ndescription: Complete final-condition sentinel\r\n---\r\n# Heading\r\nLast line';
  const id = store.importFile({ repository: 'fixture/api', commit: 'fixed', path: 'a/SKILL.md', packagePath: 'a', kind: 'skill', content: Buffer.from(source) });
  const hash = store.getFile(id).hash;
  store.close();
  const child = spawn(process.execPath, ['src/server.ts'], { cwd: resolve('.'), env: { ...process.env, PORT: '0', SKILLGRAPH_DB: database }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  const url = await new Promise<string>((done, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 15_000);
    child.stdout.on('data', (data) => { output += String(data); const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output); if (match) { clearTimeout(timeout); done(match[0]); } });
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${output}`)); });
  });
  try {
    const stats = await (await fetch(`${url}/api/stats`)).json(); assert.equal(stats.skills, 1);
    const catalog = await (await fetch(`${url}/api/catalog?maxTokens=8000`)).json();
    assert.equal(catalog.complete, true); assert.equal(catalog.format, 'compact');
    assert.ok(catalog.text.includes('Complete final-condition sentinel'));
    const mapped = await (await fetch(`${url}/api/resolve?handle=s1&catalogHash=${catalog.catalogHash}`)).json();
    assert.equal(mapped.id, id); assert.equal(mapped.hash, hash);
    const response = await fetch(`${url}/api/lines?id=${id}&start=1&end=6&hash=${hash}`);
    const body = await response.json(); assert.equal(body.text, source); assert.equal(body.numberedText, undefined);
    assert.equal(body.startLine, 1); assert.equal(body.totalLines, 6);
    const stale = await fetch(`${url}/api/lines?id=${id}&start=1&end=6&hash=old`);
    assert.equal(stale.status, 400); assert.equal((await stale.json()).error, 'STALE_CITATION');
    const tooSmall = await fetch(`${url}/api/catalog?maxTokens=1`);
    assert.equal(tooSmall.status, 400); assert.equal((await tooSmall.json()).error, 'CATALOG_HEADER_TOO_LARGE');
    const reports = await (await fetch(`${url}/api/reports`)).json();
    assert.ok(reports.import); assert.ok(reports.benchmark); assert.ok(reports['gitskills-import']);
    if (existsSync(resolve('data/import.json'))) assert.ok(Array.isArray(reports.import.repositories));
    if (existsSync(resolve('data/gitskills-import.json'))) assert.equal(reports['gitskills-import'].status !== 'not_run', true);
    if (existsSync(resolve('reports/benchmark-summary.json'))) {
      assert.equal(reports.benchmark.summaryOnly, true);
      assert.equal(reports.benchmark.scopes[0].scope, 'ALL');
    }
    assert.equal((await fetch(`${url}/api/stats`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${url}/data/skillgraph.sqlite`)).status, 404);
  } finally {
    child.kill();
    await new Promise<void>((done) => child.exitCode !== null ? done() : child.once('exit', () => done()));
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + '\\') || resolve(dir).startsWith(resolve(tmpdir()) + '/'));
    rmSync(dir, { recursive: true, force: true });
  }
});
