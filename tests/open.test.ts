import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SkillStore } from '../src/core.ts';

test('direct handle reads preserve whole source, pin package references and reject stale scopes', () => {
  const store = new SkillStore(':memory:');
  const source = '---\r\nname: example\r\ndescription: Full description\r\n---\r\n# Last rule\r\nNever skip this.';
  try {
    const id = store.importFile({ repository: 'a/repo', commit: 'old', path: 'pkg/SKILL.md', packagePath: 'pkg', kind: 'skill', content: Buffer.from(source) });
    for (const [commit, text] of [['old', 'Pinned reference'], ['new', 'Wrong version']]) {
      store.importFile({ repository: 'a/repo', commit, path: 'pkg/guide.md', packagePath: 'pkg', kind: 'reference', content: Buffer.from(text) });
    }
    const page = store.compactCatalog({ repository: 'a/repo' });
    const receipt = store.openHandle('s1', page.catalogHash, { repository: 'a/repo' });
    assert.equal(receipt.text, source); assert.equal(receipt.hash, store.getFile(id).hash);
    assert.equal(receipt.utf8Bytes, Buffer.byteLength(source));
    assert.equal(store.openHandle('s1', page.catalogHash, { repository: 'a/repo', reference: 'guide.md' }).text, 'Pinned reference');
    assert.throws(() => store.openHandle('s1', page.catalogHash, { repository: 'other/repo' }), { code: 'STALE_CATALOG' });
    assert.throws(() => store.openHandle('s1', page.catalogHash, { repository: 'a/repo', reference: '../escape' }), { code: 'INVALID_PATH' });
    assert.throws(() => store.openHandle('s1', page.catalogHash, { repository: 'a/repo', reference: 'missing.md' }), { code: 'FILE_NOT_FOUND' });
    assert.throws(() => store.openHandle('s1', 'stale'), { code: 'STALE_CATALOG' });
  } finally { store.close(); }
});

test('text-wire CLI returns a verifiable receipt and exact unescaped original bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skillgraph-open-'));
  const database = join(dir, 'test.sqlite');
  const source = '---\r\nname: quoted\r\ndescription: Exact final condition\r\n---\r\n"quoted" \\ path\r\nFinal ไทย';
  const store = new SkillStore(database);
  store.importFile({ repository: 'test/cli', commit: 'fixed', path: 'p/SKILL.md', packagePath: 'p', kind: 'skill', content: Buffer.from(source) });
  store.close();
  const cli = (args: string[]) => {
    const run = spawnSync(process.execPath, ['src/cli.ts', ...args, '--db', database], { encoding: 'utf8', windowsHide: true });
    assert.equal(run.status, 0, run.stderr); return run.stdout;
  };
  try {
    const catalog = cli(['catalog', '--wire', 'text']);
    const envelope = JSON.parse(catalog.slice(0, catalog.indexOf('\n')));
    assert.equal(envelope.total, 1); assert.equal(envelope.nextOffset, null);
    assert.ok(catalog.includes('Exact final condition'));
    const opened = cli(['open', '--handle', 's1', '--catalogHash', envelope.catalogHash, '--wire', 'text']);
    const split = opened.indexOf('\n');
    const receipt = JSON.parse(opened.slice(0, split));
    assert.equal(receipt.path, 'p/SKILL.md');
    assert.equal(receipt.utf8Bytes, Buffer.byteLength(source));
    assert.equal(opened.slice(split + 1), source);
    const lean = cli(['open', '--handle', 's1', '--catalogHash', envelope.catalogHash, '--wire', 'lean']);
    const at = lean.indexOf('\n');
    const compactReceipt = JSON.parse(lean.slice(0, at));
    assert.deepEqual(compactReceipt, [receipt.repository, receipt.commit, receipt.path, receipt.hash,
      [receipt.startLine, receipt.endLine, receipt.totalLines], receipt.utf8Bytes, receipt.errors]);
    assert.equal(lean.slice(at + 1), source);
    const cached = JSON.parse(cli(['catalog', '--knownHash', envelope.catalogHash, '--wire', 'packed']));
    assert.deepEqual(cached, { unchanged: true, total: 1 });
    const otherScope = cli(['catalog', '--repository', 'different/repo', '--knownHash', envelope.catalogHash, '--wire', 'packed']);
    assert.equal(JSON.parse(otherScope.split('\n')[0]).total, 0);
    assert.equal(JSON.parse(otherScope.split('\n')[0]).unchanged, undefined);
    const writer = new SkillStore(database);
    writer.importFile({ repository: 'test/cli', commit: 'new', path: 'p/SKILL.md', packagePath: 'p', kind: 'skill', content: Buffer.from(source + '\nNew snapshot') });
    writer.close();
    const changed = cli(['catalog', '--knownHash', envelope.catalogHash, '--wire', 'packed']);
    const changedReceipt = JSON.parse(changed.split('\n')[0]);
    assert.equal(changedReceipt.total, 2);
    assert.notEqual(changedReceipt.catalogHash, envelope.catalogHash);
    assert.equal(changedReceipt.unchanged, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('batch CLI frames complete Unicode sources and emits nothing on a later invalid handle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skillgraph-batch-'));
  const database = join(dir, 'test.sqlite');
  const store = new SkillStore(database);
  const sources = ['---\r\nname: first\r\ndescription: Full first\r\n---\r\nไทย without final newline',
    '---\nname: second\ndescription: Full second\n---\nJSON-looking {"count":0}\n'];
  for (let n = 0; n < sources.length; n++) store.importFile({ repository: 'test/batch', commit: 'fixed', path: `${n}/SKILL.md`, packagePath: String(n), kind: 'skill', content: Buffer.from(sources[n]) });
  const catalog = store.compactCatalog();
  const expected = ['s1', 's2'].map(handle => store.openHandle(handle, catalog.catalogHash).text);
  store.close();
  const run = (handles: string) => spawnSync(process.execPath, ['src/cli.ts', 'open-many', '--handles', handles, '--catalogHash', catalog.catalogHash, '--wire', 'lean', '--db', database], { windowsHide: true });
  try {
    const result = run('s1,s2'); assert.equal(result.status, 0, result.stderr.toString());
    const bytes = result.stdout; let cursor = 0;
    const line = () => { const end = bytes.indexOf(10, cursor); assert.ok(end >= cursor); const data = JSON.parse(bytes.subarray(cursor, end).toString()); cursor = end + 1; return data; };
    assert.deepEqual(line(), { format: 'sources-v1', count: 2 });
    for (const source of expected) {
      const receipt = line();
      assert.equal(receipt[5], Buffer.byteLength(source));
      assert.equal(bytes.subarray(cursor, cursor + receipt[5]).toString(), source);
      cursor += receipt[5]; assert.equal(bytes[cursor++], 10);
    }
    assert.equal(cursor, bytes.length);
    const invalid = run('s1,s99'); assert.equal(invalid.status, 1); assert.equal(invalid.stdout.length, 0);
    const duplicate = run('s1,s1'); assert.equal(duplicate.status, 1); assert.equal(duplicate.stdout.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
