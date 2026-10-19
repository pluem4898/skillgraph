import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SkillStore } from '../src/core.ts';

const args = process.argv.slice(2);
const value = (key: string, fallback: string) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1] || fallback; };
const database = resolve(value('--db', 'data/skillgraph.sqlite'));
const output = resolve(value('--out', 'reports/integrity.json'));
const source = new DatabaseSync(database, { readOnly: true });
const store = new SkillStore(database);
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const failures: object[] = [];
const report = {
  checkedAt: new Date().toISOString(), database, status: 'running',
  measurement: 'Stored-byte integrity and generated catalog coverage; not proof of AI receipt or comprehension.',
  blobCount: 0, verifiedBytes: 0, fileOccurrences: 0, skillsExpected: 0, catalogOccurrences: 0,
  catalogPages: 0, oversizedCatalogEntries: [] as object[], catalogHash: '',
  snapshotIdsVerified: 0, canonicalPinnedRepositories: [] as object[],
  sourceGaps: null as unknown, failures,
};
try {
  const check = source.prepare('PRAGMA quick_check').get();
  if (!check || Object.values(check)[0] !== 'ok') failures.push({ type: 'SQLITE_INTEGRITY', check });
  const foreignKeys = source.prepare('PRAGMA foreign_key_check').all();
  if (foreignKeys.length) failures.push({ type: 'FOREIGN_KEYS', rows: foreignKeys });
  for (const row of source.prepare('SELECT hash,content,text,size,total_lines FROM blobs').iterate()) {
    const bytes = row.content as Uint8Array;
    report.blobCount++; report.verifiedBytes += bytes.byteLength;
    if (hash(bytes) !== row.hash || bytes.byteLength !== row.size) failures.push({ type: 'BLOB_CORRUPTED', hash: row.hash });
    if (typeof row.text === 'string') {
      if (!Buffer.from(row.text).equals(Buffer.from(bytes))) failures.push({ type: 'TEXT_CHANGED', hash: row.hash });
      const lines = row.text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g)?.length || 0;
      if (lines !== row.total_lines) failures.push({ type: 'LINE_COUNT', hash: row.hash, actual: lines, stored: row.total_lines });
    }
  }
  console.log(`Verified ${report.blobCount} unique stored blobs`);
  for (const row of source.prepare('SELECT id,repository,commit_sha,path FROM files').iterate()) {
    report.fileOccurrences++;
    if (hash(JSON.stringify([row.repository, row.commit_sha, row.path])) !== row.id) failures.push({ type: 'SNAPSHOT_ID', id: row.id });
    else report.snapshotIdsVerified++;
  }
  const expected = source.prepare("SELECT id,name,description,path,errors_json FROM files WHERE kind='skill' ORDER BY id").all();
  report.skillsExpected = expected.length;
  let offset = 0;
  do {
    let page;
    try { page = store.compactCatalog({ offset, maxTokens: 16000 }); }
    catch (error) {
      const e = error as Error & { code?: string; details?: { requiredTokens?: number } };
      if (e.code !== 'ENTRY_TOO_LARGE' || !e.details?.requiredTokens) throw error;
      report.oversizedCatalogEntries.push({ offset, requiredTokens: e.details.requiredTokens });
      page = store.compactCatalog({ offset, maxTokens: e.details.requiredTokens });
    }
    if (report.catalogHash && page.catalogHash !== report.catalogHash) throw new Error('Catalog changed during audit');
    report.catalogHash = page.catalogHash;
    const rows = page.text.trimEnd().split('\n').slice(1).map(line => JSON.parse(line));
    if (rows.length !== page.returned || page.total !== expected.length) failures.push({ type: 'CATALOG_ENVELOPE', offset });
    for (let index = 0; index < rows.length; index++) {
      const original = expected[offset + index];
      const want = [`s${offset + index + 1}`, original.name, original.description, original.path, JSON.parse(String(original.errors_json))];
      if (JSON.stringify(rows[index]) !== JSON.stringify(want)) failures.push({ type: 'CATALOG_TEXT_CHANGED', offset: offset + index, id: original.id });
    }
    report.catalogPages++; report.catalogOccurrences += rows.length;
    if (page.nextOffset === null) break;
    if (page.nextOffset !== offset + rows.length || !rows.length) throw new Error('Catalog cursor skipped entries or made no progress');
    offset = page.nextOffset;
  } while (offset < expected.length);
  if (report.catalogOccurrences !== expected.length) failures.push({ type: 'CATALOG_INCOMPLETE', expected: expected.length, actual: report.catalogOccurrences });
  try {
    const imported = JSON.parse(readFileSync(resolve('data/import.json'), 'utf8'));
    for (const repo of imported.repositories) {
      const actual = Number(source.prepare("SELECT COUNT(*) total FROM files WHERE repository=? AND commit_sha=? AND kind='skill'").get(repo.repository, repo.commit)?.total);
      const expectedSkills = repo.expectedSkills.length;
      report.canonicalPinnedRepositories.push({ repository: repo.repository, commit: repo.commit, treeVerification: repo.treeVerification, expectedSkills, actualSkills: actual, excludedNonRegularEntries: repo.rejectedEntries.length, archiveRepairs: repo.repairedPaths?.length || 0 });
      if (actual !== expectedSkills) failures.push({ type: 'PINNED_SKILL_COVERAGE', repository: repo.repository, expected: expectedSkills, actual });
    }
    const sample = JSON.parse(readFileSync(resolve('data/gitskills-import.json'), 'utf8'));
    report.sourceGaps = { sampleArtifactContentsComplete: sample.coverage.artifactContentsComplete, sampleSiblingContentsComplete: sample.coverage.siblingContentsComplete, unavailableSiblingRows: sample.unavailableSiblingRows, integrityFailures: sample.integrityFailures, note: 'These source gaps remain explicit; generated catalog coverage does not imply complete supporting packages.' };
  } catch (error) { report.sourceGaps = { manifestStatus: 'unavailable', error: String(error) }; }
  report.status = failures.length ? 'failed' : 'passed_with_declared_source_gaps';
} finally {
  source.close(); store.close();
  mkdirSync(resolve(output, '..'), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ report: output, status: report.status, blobs: report.blobCount, skillsCatalogued: report.catalogOccurrences, failures: failures.length }));
if (failures.length) process.exitCode = 1;
