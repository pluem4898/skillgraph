import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillStore, tokenize } from '../src/core.ts';
import { packedCatalog } from '../src/wire.ts';

function decode(text: string) {
  const [first, ...lines] = text.trimEnd().split('\n');
  const header = JSON.parse(first);
  const rows = lines.map((line, i) => {
    const [name, description, overrides = {}] = JSON.parse(line);
    return [`s${header.handleStart + i}`, name, description,
      overrides.path ?? header.defaults.pathPrefix + name + header.defaults.pathSuffix,
      overrides.errors ?? header.defaults.errors];
  });
  return { header, rows };
}

test('packed catalog round-trips names, descriptions, arbitrary paths and diagnostics', () => {
  const store = new SkillStore(':memory:');
  try {
    for (let n = 0; n < 12; n++) store.importFile({ repository: 'test/packed', commit: 'fixed',
      path: n === 0 ? 'unusual folder/ไทย.md' : `skills/name-${n}/SKILL.md`, packagePath: '', kind: 'skill',
      content: Buffer.from(n === 0 ? 'Malformed but still visible' : `---\nname: name-${n}\ndescription: 'Full quote " and ไทย ${n}'\n---\nLast governing rule`) });
    const page = store.compactCatalog();
    const packed = decode(packedCatalog(page, 16000));
    assert.deepEqual(packed.rows, page.text.trimEnd().split('\n').slice(1).map(line => JSON.parse(line)));
    assert.equal(packed.header.total, 12);
    assert.equal(packed.header.nextOffset, null);
    assert.equal(packed.header.catalogHash, page.catalogHash);
  } finally { store.close(); }
});

test('packed response budgets retain whole rows and a contiguous next offset', () => {
  const store = new SkillStore(':memory:');
  try {
    for (let n = 0; n < 16; n++) store.importFile({ repository: 'test/packed', commit: 'fixed', path: `skills/name-${n}/SKILL.md`,
      packagePath: '', kind: 'skill', content: Buffer.from(`---\nname: name-${n}\ndescription: '${'Full description '.repeat(10)}FINAL-${n}'\n---\n`) });
    const expected = store.compactCatalog().text.trimEnd().split('\n').slice(1).map(line => JSON.parse(line));
    const received: unknown[] = [];
    let offset = 0;
    do {
      const text = packedCatalog(store.compactCatalog({ offset }), 450);
      assert.ok(tokenize(text) <= 450);
      const decoded = decode(text);
      assert.equal(decoded.header.offset, received.length);
      received.push(...decoded.rows);
      if (decoded.header.nextOffset === null) break;
      assert.equal(decoded.header.nextOffset, offset + decoded.rows.length);
      offset = decoded.header.nextOffset;
    } while (true);
    assert.deepEqual(received, expected);
    assert.throws(() => packedCatalog(store.compactCatalog(), 1), { code: 'ENTRY_TOO_LARGE' });
  } finally { store.close(); }
});
