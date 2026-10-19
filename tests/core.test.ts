import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SkillStore, parseSkill, tokenize } from '../src/core.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'skillgraph-core-'));
  const store = new SkillStore(join(dir, 'test.sqlite'));
  return { store, dir, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const skill = (name: string, description = 'Full description') => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nBody.\n`;
function insert(store: SkillStore, path: string, text: string | Buffer, extra: Partial<Parameters<SkillStore['importFile']>[0]> = {}) {
  return store.importFile({ repository: 'example/skills', commit: 'abc123', path, packagePath: path.split('/').slice(0, -1).join('/'), kind: 'skill', content: Buffer.isBuffer(text) ? text : Buffer.from(text), ...extra });
}

test('multiline YAML and real markdown headings preserve original line coordinates', () => {
  const text = '---\r\nname: test\r\ndescription: |\r\n  First line\r\n  Second line\r\n---\r\n# Title\r\n```md\r\n# Not a heading\r\n```\r\n## Child\r\n[Guide](references/a.md)\r\n# Next\r\n';
  const parsed = parseSkill(text);
  assert.equal(parsed.description, 'First line\nSecond line\n');
  assert.deepEqual(parsed.headings, [{ title: 'Title', level: 1, startLine: 7, endLine: 12 }, { title: 'Child', level: 2, startLine: 11, endLine: 12 }, { title: 'Next', level: 1, startLine: 13, endLine: 13 }]);
  assert.deepEqual(parsed.links, [{ target: 'references/a.md', line: 12 }]);
  assert.deepEqual(parsed.errors, []);
});

test('all skill names and full descriptions are visible; pagination never splits entries', () => {
  const f = fixture();
  try {
    const description = 'Detail '.repeat(100) + 'TAIL SENTINEL';
    insert(f.store, 'a/SKILL.md', skill('a', description));
    insert(f.store, 'b/SKILL.md', skill('b', 'Another description'));
    const all = f.store.catalog();
    assert.equal(all.returned, 2); assert.equal(all.complete, true);
    assert.equal(all.tokenCount, tokenize(all.text)); assert.ok(all.text.includes(description));
    const entryLines = all.text.trimEnd().split('\n');
    const firstBudget = tokenize(entryLines.slice(0, 2).join('\n') + '\n');
    const first = f.store.catalog({ maxTokens: firstBudget });
    assert.equal(first.returned, 1); assert.equal(first.nextOffset, 1); assert.equal(first.complete, false);
    const second = f.store.catalog({ offset: first.nextOffset! });
    assert.equal(second.returned, 1); assert.equal(second.complete, false); assert.equal(second.nextOffset, null);
    assert.equal(first.catalogHash, second.catalogHash);
    assert.throws(() => f.store.catalog({ maxTokens: firstBudget - 1 }), { code: 'ENTRY_TOO_LARGE' });
    assert.throws(() => f.store.catalog({ maxTokens: 1 }), { code: 'CATALOG_HEADER_TOO_LARGE' });
    assert.equal(f.store.listSkills({ offset: 0, limit: 1 }).nextOffset, 1);
  } finally { f.close(); }
});

test('source bytes, CRLF, line slices, and UTF-8 BOM are lossless', () => {
  const f = fixture();
  try {
    const text = '\uFEFF---\r\nname: ไทย\r\ndescription: ครบทุกตัวอักษร\r\n---\r\n# หัวข้อ\r\nlast';
    const id = insert(f.store, 'thai/SKILL.md', text);
    const file = f.store.getFile(id);
    assert.equal(file.text, text); assert.equal(file.totalLines, 6);
    const read = f.store.readLines(id, 2, 3, file.hash);
    assert.equal(read.text, 'name: ไทย\r\ndescription: ครบทุกตัวอักษร\r\n');
    assert.equal(read.numberedText, '2|name: ไทย\r\n3|description: ครบทุกตัวอักษร\r\n');
    assert.throws(() => f.store.readLines(id, 1, 7), { code: 'INVALID_LINE_RANGE' });
    assert.throws(() => f.store.readLines(id, 1, 1, 'old-hash'), { code: 'STALE_CITATION' });
  } finally { f.close(); }
});

test('duplicate content deduplicates storage while aliases and commit snapshots remain distinct', () => {
  const f = fixture();
  try {
    const text = skill('same');
    const first = insert(f.store, 'a/SKILL.md', text);
    const alias = insert(f.store, 'b/SKILL.md', text);
    const next = insert(f.store, 'a/SKILL.md', text, { commit: 'next' });
    assert.notEqual(first, alias); assert.notEqual(first, next);
    assert.equal(insert(f.store, 'a/SKILL.md', text), first);
    assert.equal(f.store.getStats().files, 3); assert.equal(f.store.getStats().blobs, 1);
    assert.throws(() => insert(f.store, 'a/SKILL.md', skill('changed')), { code: 'SNAPSHOT_CONFLICT' });
  } finally { f.close(); }
});

test('invalid YAML and non-UTF-8/binary skills remain listed with explicit errors', () => {
  const f = fixture();
  try {
    const invalid = insert(f.store, 'bad/SKILL.md', '---\nname: bad\ndescription: [unclosed\n---\n# Body\n');
    assert.ok(f.store.getFile(invalid).errors.some((e) => e.startsWith('YAML_INVALID')));
    const binary = insert(f.store, 'binary/SKILL.md', Buffer.from([0xff, 0x00, 0x41]));
    assert.equal(f.store.getFile(binary).text, null);
    assert.equal(f.store.getFile(binary).encoding, 'binary');
    assert.throws(() => f.store.readLines(binary, 1, 1), { code: 'BINARY_CONTENT' });
    assert.equal(f.store.catalog().total, 2); assert.ok(f.store.catalog().text.includes('INVALID_UTF8'));
  } finally { f.close(); }
});

test('relative and reference-style links resolve within the same repository snapshot', () => {
  const f = fixture();
  try {
    const id = insert(f.store, 'a/SKILL.md', skill('a') + '[Guide][g]\n\n[g]: refs/guide.md\n\n[missing](absent.md)\n[escape](../../secret)\n[web](https://example.com)\n[anchor](#part)\n');
    assert.equal(f.store.getFile(id).links[0].status, 'missing');
    const guide = insert(f.store, 'a/refs/guide.md', '# Guide\n', { kind: 'reference', packagePath: 'a' });
    const links = f.store.getFile(id).links;
    assert.equal(links[0].fileId, guide);
    assert.deepEqual(links.map((l) => l.status), ['resolved', 'missing', 'outside_repository', 'external', 'anchor']);
    assert.equal(f.store.listFiles({ packagePath: 'a' }).total, 2);
  } finally { f.close(); }
});

test('content corruption is detected rather than returning a false citation', () => {
  const f = fixture();
  try {
    const id = insert(f.store, 'a/SKILL.md', skill('a'));
    const db = new DatabaseSync(join(f.dir, 'test.sqlite'));
    db.prepare('UPDATE blobs SET content = ?').run(Buffer.from('tampered')); db.close();
    assert.throws(() => f.store.getFile(id), { code: 'CONTENT_CORRUPTED' });
  } finally { f.close(); }
});

test('arbitrary text containing tokenizer control strings counts as plain text', () => {
  assert.ok(tokenize('literal <|endoftext|> and <|fim_prefix|>') > 0);
  assert.equal(tokenize(''), 0);
});

test('unclosed frontmatter remains visible and empty file ranges are rejected', () => {
  const f = fixture();
  try {
    const id = insert(f.store, 'a/SKILL.md', '---\nname: a\n');
    assert.ok(f.store.getFile(id).errors.some((e) => e.startsWith('FRONTMATTER_UNCLOSED')));
    const empty = insert(f.store, 'empty/SKILL.md', '');
    assert.equal(f.store.getFile(empty).totalLines, 0);
    assert.throws(() => f.store.readLines(empty, 1, 1), { code: 'INVALID_LINE_RANGE' });
    assert.throws(() => insert(f.store, '../SKILL.md', ''), { code: 'INVALID_PATH' });
  } finally { f.close(); }
});

test('compact handles preserve every discovery field and resolve only within the pinned catalog', () => {
  const f = fixture();
  try {
    insert(f.store, 'a/SKILL.md', '---\nname: first\ndescription: Full unshortened description with final condition.\n---\n# A\n');
    insert(f.store, 'b/SKILL.md', '---\nname: second\ndescription: Another complete description.\n---\n# B\n');
    const full = f.store.catalog();
    const compact = f.store.compactCatalog();
    const oldRows = full.text.trimEnd().split('\n').slice(1).map(s => JSON.parse(s));
    const rows = compact.text.trimEnd().split('\n').slice(1).map(s => JSON.parse(s));
    assert.equal(compact.catalogHash, full.catalogHash);
    assert.equal(rows.length, oldRows.length);
    rows.forEach((row, i) => {
      assert.deepEqual(row.slice(1), [oldRows[i][1], oldRows[i][2], oldRows[i][3], oldRows[i][5]]);
      const metadata = f.store.resolveHandle(row[0], compact.catalogHash);
      assert.equal(metadata.id, oldRows[i][0]); assert.equal(metadata.hash, oldRows[i][4]);
    });
    assert.ok(compact.tokenCount < full.tokenCount);
    assert.throws(() => f.store.resolveHandle('s0', compact.catalogHash), { code: 'INVALID_HANDLE' });
    insert(f.store, 'c/SKILL.md', '---\nname: third\ndescription: Added later\n---\n');
    assert.throws(() => f.store.resolveHandle('s1', compact.catalogHash), { code: 'STALE_CATALOG' });
  } finally { f.close(); }
});
