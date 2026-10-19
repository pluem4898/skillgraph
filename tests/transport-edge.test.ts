import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillStore, tokenize } from '../src/core.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'skillgraph-transport-'));
  const path = join(dir, 'store.sqlite');
  const store = new SkillStore(path);
  return { path, store, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function add(store: SkillStore, n: number, description = `Full description ${n}`) {
  return store.importFile({ repository: 'test/corpus', commit: 'fixed', path: `s${n}/SKILL.md`, packagePath: `s${n}`, kind: 'skill', content: Buffer.from(`---\nname: skill-${n}\ndescription: ${JSON.stringify(description)}\n---\n# Source\nLast exception ${n}\n`) });
}

test('catalog invalidates across database connections and rejects an old handle digest', () => {
  const f = fixture();
  try {
    add(f.store, 1);
    const before = f.store.compactCatalog();
    const writer = new SkillStore(f.path);
    try { add(writer, 2); } finally { writer.close(); }
    const after = f.store.compactCatalog();
    assert.equal(after.total, 2); assert.notEqual(before.catalogHash, after.catalogHash);
    assert.throws(() => f.store.resolveHandle('s1', before.catalogHash), { code: 'STALE_CATALOG' });
  } finally { f.close(); }
});

test('paged generation covers every occurrence once without shortening any description', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 240; i++) add(f.store, i, `Description ${i} ${'constraint '.repeat(i % 12)}FINAL-${i}`);
    const want = f.store.listSkills({ limit: 1000 }).items;
    const actual = [];
    let offset = 0, digest = '';
    do {
      const page = f.store.compactCatalog({ offset, maxTokens: 750 });
      assert.ok(page.tokenCount <= 750); assert.equal(page.tokenCount, tokenize(page.text));
      if (digest) assert.equal(page.catalogHash, digest); digest = page.catalogHash;
      actual.push(...page.text.trimEnd().split('\n').slice(1).map(line => JSON.parse(line)));
      if (page.nextOffset === null) break;
      assert.equal(page.nextOffset, offset + page.returned); offset = page.nextOffset;
    } while (offset < want.length);
    assert.equal(actual.length, want.length);
    actual.forEach((row, i) => { assert.equal(row[0], `s${i + 1}`); assert.equal(row[2], want[i].description); });
  } finally { f.close(); }
});

test('a whole oversized entry is reported explicitly rather than skipped', () => {
  const f = fixture();
  try {
    add(f.store, 1, 'Complete condition '.repeat(1500) + 'DO NOT REMOVE FINAL EXCEPTION');
    add(f.store, 2);
    const all = f.store.compactCatalog();
    const rows = all.text.trimEnd().split('\n').slice(1).map(line => JSON.parse(line));
    const offset = rows.findIndex(row => row[2].includes('DO NOT REMOVE'));
    let required = 0;
    assert.throws(() => f.store.compactCatalog({ offset, maxTokens: 500 }), (error: unknown) => {
      const e = error as { code: string; details: { requiredTokens: number } };
      required = e.details.requiredTokens; return e.code === 'ENTRY_TOO_LARGE' && required > 500;
    });
    const page = f.store.compactCatalog({ offset, maxTokens: required });
    assert.equal(page.offset, offset); assert.ok(page.text.includes('DO NOT REMOVE FINAL EXCEPTION'));
  } finally { f.close(); }
});

test('carriage-return-only source lines and the final unterminated line remain exact', () => {
  const f = fixture();
  try {
    const text = 'first\rsecond\rfinal';
    const id = f.store.importFile({ repository: 'test/lines', commit: 'fixed', path: 'notes.txt', packagePath: '', kind: 'reference', content: Buffer.from(text) });
    const file = f.store.getFile(id);
    assert.equal(file.totalLines, 3);
    assert.equal(f.store.readLines(id, 2, 3, file.hash).text, 'second\rfinal');
    assert.equal(f.store.readLines(id, 1, 3, file.hash).text, text);
  } finally { f.close(); }
});

test('reopening the same immutable corpus preserves catalog order and digest', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 9; i++) add(f.store, i);
    const before = f.store.compactCatalog();
    const reopened = new SkillStore(f.path);
    try {
      const after = reopened.compactCatalog();
      assert.equal(after.text, before.text); assert.equal(after.catalogHash, before.catalogHash);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('a handle cannot be resolved against a different catalog content set', () => {
  const f = fixture();
  try {
    add(f.store, 1);
    f.store.importFile({ repository: 'other/corpus', commit: 'fixed', path: 'SKILL.md', packagePath: '', kind: 'skill', content: Buffer.from('---\nname: other\ndescription: Other scope\n---\n') });
    const page = f.store.compactCatalog({ repository: 'test/corpus' });
    assert.throws(() => f.store.resolveHandle('s1', page.catalogHash, 'other/corpus'), { code: 'STALE_CATALOG' });
  } finally { f.close(); }
});
