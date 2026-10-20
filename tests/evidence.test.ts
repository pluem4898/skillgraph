import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { queryEvidence } from '../src/evidence.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'skillgraph-evidence-'));
  const input = join(dir, 'input.json');
  const digest = createHash('sha256').update('bytes').digest('hex');
  const document = { evidence_id: 'fixture-evidence', operation: 'inventory_artifact', normalized_result: {
    manifest: { root_sha256: digest, node_count: 1, occurrence_count: 4, edge_count: 0 },
    nodes: [{ artifact_id: 'node', sha256: digest }], edges: [],
    occurrences: [
      { occurrence_id: 'root', artifact_id: 'node', logical_path: '.', parent_occurrence_id: null, entry_kind: 'file', declared_size: 20, hash_status: 'verified', encrypted: false },
      ...['a.gd', 'ไทย.gd', 'folder/'].map((path, i) => ({ occurrence_id: String(i), artifact_id: 'node', logical_path: path, parent_occurrence_id: 'root', entry_kind: i === 2 ? 'directory' : 'file', declared_size: i === 2 ? null : 5, hash_status: 'verified', encrypted: false })),
    ], coverage: { status: 'partial', scope: 'fixture' }, limitations: ['Intentional source gap'], integrity_contradictions: [{ message: 'Declared contradiction remains visible' }],
  } };
  writeFileSync(input, JSON.stringify(document));
  return { dir, input, document, close() { rmSync(dir, { recursive: true, force: true }); } };
}
test('evidence views preserve occurrences, Unicode paths, source gaps and paging', () => {
  const f = fixture();
  try {
    const summary = queryEvidence(f.input, { view: 'summary' });
    const answer = summary.answer as any;
    assert.equal(answer.files, 2); assert.equal(answer.directories, 1); assert.equal(answer.declaredFileBytes, 10);
    assert.deepEqual(summary.coverage, f.document.normalized_result.coverage);
    assert.deepEqual(summary.limitations, ['Intentional source gap']);
    assert.deepEqual(answer.integrityContradictions, f.document.normalized_result.integrity_contradictions);
    const first = queryEvidence(f.input, { view: 'files', extension: '.GD', limit: 1 }).answer as any;
    assert.equal(first.total, 2); assert.equal(first.items[0].path, 'a.gd'); assert.equal(first.nextOffset, 1);
    assert.equal(first.items[0].sourceIndex, 1);
    const record = queryEvidence(f.input, { view: 'record', index: first.items[0].sourceIndex }).answer as any;
    assert.deepEqual(record.occurrence, f.document.normalized_result.occurrences[1]);
    const last = queryEvidence(f.input, { view: 'files', extension: '.gd', offset: 1 }).answer as any;
    assert.equal(last.items[0].path, 'ไทย.gd'); assert.equal(last.nextOffset, null);
    const absent = queryEvidence(f.input, { view: 'files', extension: '.absent' }).answer as any;
    assert.equal(absent.total, 0); assert.equal(absent.nextOffset, null);
    f.document.normalized_result.occurrences[3].logical_path = 'folder\\';
    f.document.normalized_result.occurrences[3].entry_kind = 'file';
    f.document.normalized_result.occurrences[3].declared_size = 0;
    writeFileSync(f.input, JSON.stringify(f.document));
    const ambiguous = queryEvidence(f.input, { view: 'summary' });
    assert.equal(ambiguous.pathWarnings.backslashTerminatedFileEntries, 1);
    assert.equal((ambiguous.answer as any).files, 3); // Do not silently reinterpret producer observations.
  } finally { f.close(); }
});
test('source and query changes invalidate evidence cache; full input is retained', () => {
  const f = fixture(); const cache = join(f.dir, 'cache');
  try {
    const first = queryEvidence(f.input, { view: 'summary' }, cache);
    assert.equal(first.cacheHit, false);
    assert.equal(queryEvidence(f.input, { view: 'summary' }, cache).cacheHit, true);
    assert.equal(queryEvidence(f.input, { view: 'extensions' }, cache).cacheHit, false);
    assert.equal(queryEvidence(f.input, { view: 'files', extension: '.gd', limit: 1 }, cache).cacheHit, false);
    assert.equal(queryEvidence(f.input, { view: 'files', extension: '.gd', limit: 2 }, cache).cacheHit, false);
    const all = queryEvidence(f.input, { view: 'files' }, cache);
    assert.deepEqual({ ...queryEvidence(f.input, { view: 'files' }, cache), cacheHit: false }, all);
    f.document.normalized_result.occurrences[1].declared_size = 9;
    writeFileSync(f.input, JSON.stringify(f.document));
    const changed = queryEvidence(f.input, { view: 'summary' }, cache);
    assert.equal(changed.cacheHit, false); assert.notEqual(changed.sourceHash, first.sourceHash);
    assert.deepEqual(readFileSync(join(cache, changed.sourceHash + '.source.json')), readFileSync(f.input));
  } finally { f.close(); }
});
test('corrupt derived views and retained sources fail closed', () => {
  const f = fixture(); const cache = join(f.dir, 'cache');
  try {
    const result = queryEvidence(f.input, { view: 'summary' }, cache);
    const view = join(cache, readdirSync(cache).find(name => name.endsWith('.view.json'))!);
    const original = readFileSync(view); const changed = JSON.parse(original.toString());
    changed.payload.answer.files = 999; writeFileSync(view, JSON.stringify(changed));
    assert.throws(() => queryEvidence(f.input, { view: 'summary' }, cache), { code: 'CACHE_CORRUPTED' });
    writeFileSync(view, original); writeFileSync(join(cache, result.sourceHash + '.source.json'), 'changed');
    assert.throws(() => queryEvidence(f.input, { view: 'summary' }, cache), { code: 'CACHE_CORRUPTED' });
  } finally { f.close(); }
});
test('malformed sources, inconsistent inventories and invalid queries are not cached answers', () => {
  const f = fixture();
  try {
    assert.throws(() => queryEvidence(f.input, { view: 'summary', limit: 1 }), { code: 'INVALID_QUERY' });
    assert.throws(() => queryEvidence(f.input, { view: 'files', offset: -1 }), { code: 'INVALID_QUERY' });
    assert.throws(() => queryEvidence(f.input, { view: 'files', offset: 100 }), { code: 'INVALID_QUERY' });
    assert.throws(() => queryEvidence(f.input, { view: 'record', index: 100 }), { code: 'INVALID_QUERY' });
    f.document.normalized_result.manifest.occurrence_count = 999;
    writeFileSync(f.input, JSON.stringify(f.document));
    assert.throws(() => queryEvidence(f.input, { view: 'summary' }), { code: 'INVALID_EVIDENCE' });
    writeFileSync(f.input, '{broken');
    assert.throws(() => queryEvidence(f.input, { view: 'summary' }), { code: 'INVALID_EVIDENCE' });
  } finally { f.close(); }
});
