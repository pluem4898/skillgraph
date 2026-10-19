import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { catalogMessages, contextStatus, deduplicatedMessages, deduplicatedPayload, distribution, frame, measureMessages, measureScope, rawPayload, renderCsv, savingsPercent, sourceFrame } from '../scripts/benchmark.ts';
import type { Source } from '../scripts/benchmark.ts';
import { tokenize } from '../src/core.ts';

function source(id: string, text: string): Source {
  return { id, text, repository: 'fixture/repo', commit: 'a'.repeat(40), path: `${id}/SKILL.md`, hash: createHash('sha256').update(text).digest('hex'), totalLines: text.split('\n').length };
}
function catalog(items: Source[]): string { return JSON.stringify(['id', 'name', 'description', 'path', 'hash', 'errors']) + '\n' + items.map(item => JSON.stringify([item.id,item.id,'full description',item.path,item.hash,[]]) + '\n').join(''); }
const count = (text: string): number => { const result = tokenize(text); return typeof result === 'number' ? result : (result as { length: number }).length; };

test('source framing preserves CRLF, Thai, code fences, long body and last line verbatim', () => {
  const text = `---\r\nname: ทดสอบ\r\n---\r\n${'Important exception. '.repeat(5000)}\r\n\u0060\u0060\u0060python\r\nprint("END_SOURCE")\r\n\u0060\u0060\u0060\r\nLAST-LINE-DO-NOT-DROP`;
  const item = source('sentinel', text);
  const payload = sourceFrame(item);
  const bodyStart = payload.indexOf('\n') + 1;
  assert.equal(payload.slice(bodyStart, bodyStart + text.length), text);
  assert.ok(rawPayload([item]).includes('LAST-LINE-DO-NOT-DROP'));
  assert.ok(payload.includes(`"utf8Bytes":${Buffer.byteLength(text, 'utf8')}`));
});

test('exact dedup retains every occurrence and refuses inconsistent hash groups', () => {
  const a = source('a', 'same\r\ncontent');
  const b = { ...source('b', a.text), repository: 'other/copy' };
  const c = source('c', 'unique');
  const result = deduplicatedPayload([a, b, c]);
  assert.equal(result.uniqueContents, 2);
  assert.equal(result.text.split(a.text).length - 1, 1);
  assert.ok(result.text.includes('"id":"a"'));
  assert.ok(result.text.includes('"id":"b"'));
  assert.ok(result.text.includes('other/copy'));
  assert.throws(() => deduplicatedPayload([a, { ...b, text: 'corrupt' }]), /HASH_COLLISION_OR_CORRUPTION/);
});

test('v2 counts each distinct complete message, not a giant concatenation', () => {
  const items = [source('a', 'hello'), source('b', ' world\n')];
  const seen: string[] = [];
  const measure = (text: string) => { seen.push(text); return count(text); };
  const result = measureScope('fixture', items, catalog(items), measure);
  assert.equal(result.rawAllTokens, items.reduce((sum, item) => sum + count(rawPayload([item])), 0));
  assert.equal(seen[0], rawPayload([items[0]]));
  assert.equal(result.catalogTokens, measureMessages(catalogMessages(catalog(items)), count).tokens);
  assert.equal(result.exactDedupTokens, measureMessages(deduplicatedMessages(items), count).tokens);
  assert.equal(result.rawMessageCount, 2);
  for (const row of result.rows) {
    assert.equal(row.deliveredOnceTokens, row.catalogTokens + row.selectedTokens);
    assert.equal(row.catalogReplayTokens, row.deliveredOnceTokens + row.catalogTokens);
    assert.equal(row.deliveredOnceSavingsPercent, (1 - row.deliveredOnceTokens / row.rawAllTokens) * 100);
  }
});

test('catalog pagination preserves all complete rows including long descriptions and tail', () => {
  const entries = Array.from({ length: 257 }, (_, index) => JSON.stringify([`skill-${index}`, 'long description '.repeat(index === 128 ? 1000 : 1)]));
  const pages = [...catalogMessages('["id","description"]\n' + entries.join('\n') + '\n')];
  assert.equal(pages.length, 3);
  for (const entry of entries) assert.equal(pages.filter((page) => page.includes(entry + '\n')).length, 1);
  assert.ok(pages[1].includes('"offset":128'));
  assert.ok(pages[2].includes(entries[256]));
});

test('compact catalog keeps all discovery text and counts resolver response overhead', () => {
  const items = [source('a', 'body'), source('b', 'other')];
  const text = catalog(items);
  const pages = [...catalogMessages(text, true)];
  assert.ok(pages[0].includes('["handle","name","description","path","errors"]'));
  assert.ok(pages[0].includes('["s2","b","full description","b/SKILL.md",[]]'));
  assert.ok(pages[0].includes(createHash('sha256').update(text).digest('hex')));
  const result = measureScope('fixture', items, text, count);
  for (const row of result.rows) {
    assert.ok(row.resolutionTokens > 0);
    assert.equal(row.compactDeliveredOnceTokens, row.compactCatalogTokens + row.resolutionTokens + row.selectedTokens);
    assert.equal(row.compactCatalogReplayTokens, row.compactDeliveredOnceTokens + row.compactCatalogTokens);
  }
  assert.throws(() => [...catalogMessages('wrong header\n', true)], /INVALID_COMPACT_CATALOG_SCHEMA/);
});

test('sequence hashes preserve boundaries and order and consume an iterable once', () => {
  assert.notEqual(measureMessages(['ab', 'c'], count).hash, measureMessages(['a', 'bc'], count).hash);
  assert.notEqual(measureMessages(['a', 'b'], count).hash, measureMessages(['b', 'a'], count).hash);
  let delivered = 0;
  function* messages() { for (const message of ['a', 'b', 'c']) { delivered++; yield message; } }
  const measured = measureMessages(messages(), count);
  assert.equal(delivered, 3);
  assert.equal(measured.messageCount, 3);
  assert.equal(measured.tokens, count('a') + count('b') + count('c'));
});

test('every occurrence becomes a target, including duplicate and final skills', () => {
  const items = [source('first', 'shared'), source('middle', 'shared'), source('last', 'tail-only exception')];
  const result = measureScope('fixture', items, catalog(items), count);
  assert.deepEqual(result.rows.map((row) => row.id), items.map((item) => item.id));
  assert.equal(result.occurrences, 3);
  assert.equal(result.uniqueContents, 2);
  assert.equal(result.deliveredOnceTokens.count, 3);
  assert.equal(result.deliveredOnceTokens.sum, result.rows.reduce((total, row) => total + row.deliveredOnceTokens, 0));
});

test('context overflow preserves true counts, reservation and exact boundary', () => {
  assert.equal(contextStatus(27_904, 32_000).status, 'FITS_PAYLOAD_BUDGET');
  assert.equal(contextStatus(27_905, 32_000).status, 'CONTEXT_OVERFLOW');
  assert.equal(contextStatus(27_905, 32_000).excessTokens, 1);
  const result = measureScope('large', [source('a', 'a')], catalog([source('a', 'a')]), () => 100_000);
  assert.equal(result.rawAllTokens, 100_000);
  assert.equal(result.context[0].status, 'CONTEXT_OVERFLOW');
  assert.equal(result.context[1].oracleResidentOverflowCount, 1);
});

test('statistics and negative savings are honest at small sizes', () => {
  assert.deepEqual(distribution([]), { count: 0, min: null, median: null, p95: null, max: null, mean: null, sum: 0 });
  assert.deepEqual(distribution([4, 1, 3, 2]), { count: 4, min: 1, median: 2.5, p95: 4, max: 4, mean: 2.5, sum: 10 });
  assert.equal(savingsPercent(100, 150), -50);
  assert.equal(savingsPercent(0, 0), null);
});

test('CSV escapes commas and quotes and includes all targets', () => {
  const item = { ...source('quoted', 'body'), path: 'a,"b"/SKILL.md' };
  const result = measureScope('fixture', [item], catalog([item]), count);
  const csv = renderCsv([result]);
  assert.ok(csv.includes('"a,""b""/SKILL.md"'));
  assert.equal(csv.trimEnd().split('\n').length, 2);
});
