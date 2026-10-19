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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
