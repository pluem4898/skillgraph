import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync, unlinkSync, openSync, closeSync, readSync } from 'node:fs';
import { resolve, dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { SkillStore } from '../src/core.ts';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argument = (key: string, fallback?: string) => { const i = args.indexOf(key); if (i < 0) return fallback; const value = args[i + 1]; if (!value || value.startsWith('--')) throw new Error(`Missing ${key} value`); return value; };
const sampleRepository = 'giuseppedestefanis/gitskills-sample';
const sampleRevision = 'fff3df93beeee51a5444450891751f143e38da3e';
const archiveBlob = 'b2c5b19033285d2361a20df94d36e3eb922b6a1a';
const cap = 512 * 1024 * 1024;
const maxRepairBytes = 8 * 1024 * 1024;
const sourceUrl = `https://raw.githubusercontent.com/${sampleRepository}/${sampleRevision}/agent_skills_sample.zip`;
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
function gitBlobHash(bytes: Buffer) { return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); }
async function digest(path: string, algorithm = 'sha256', gitBlob = false) {
  const hash = createHash(algorithm);
  if (gitBlob) hash.update(`blob ${statSync(path).size}\0`);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
async function download(target: string) {
  if (existsSync(target)) { if (statSync(target).size > cap) throw new Error('Cached ZIP exceeds sample cap'); return; }
  const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(600_000), headers: { 'User-Agent': 'SkillGraph-Research' } });
  if (!response.ok || !response.body) throw new Error(`Sample HTTP ${response.status}`);
  if (Number(response.headers.get('content-length') || 0) > cap) throw new Error('Sample ZIP exceeds 512 MiB cap');
  const temporary = target + '.partial';
  const output = createWriteStream(temporary);
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > cap) throw new Error('Sample ZIP exceeds 512 MiB cap');
      if (!output.write(chunk)) await once(output, 'drain');
    }
    output.end(); await once(output, 'finish'); renameSync(temporary, target);
  } catch (e) { output.destroy(); if (existsSync(temporary)) unlinkSync(temporary); throw e; }
}
/** Read only the named regular DB entry; never extract archive-supplied paths. ZIP64/encrypted files are rejected. */
async function extractDatabase(archive: string, target: string) {
  const fd = openSync(archive, 'r');
  const read = (offset: number, size: number) => { const b = Buffer.alloc(size); if (readSync(fd, b, 0, size, offset) !== size) throw new Error('Truncated ZIP'); return b; };
  try {
    const size = statSync(archive).size;
    const tail = read(Math.max(0, size - 65_557), Math.min(size, 65_557));
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
    if (end < 0) throw new Error('ZIP central directory not found');
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)) throw new Error('Multipart ZIP unsupported');
    const count = tail.readUInt16LE(end + 10), centralSize = tail.readUInt32LE(end + 12), centralOffset = tail.readUInt32LE(end + 16);
    if (count === 65535 || centralSize === 0xffffffff || centralOffset === 0xffffffff || centralSize > 4 * 1024 * 1024) throw new Error('ZIP64/oversized central directory unsupported');
    const central = read(centralOffset, centralSize);
    let at = 0, candidate: { offset: number; compressed: number; expanded: number; method: number } | undefined;
    for (let n = 0; n < count; n++) {
      if (central.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid ZIP directory entry');
      const flags = central.readUInt16LE(at + 8), method = central.readUInt16LE(at + 10);
      const compressed = central.readUInt32LE(at + 20), expanded = central.readUInt32LE(at + 24);
      const length = central.readUInt16LE(at + 28), extra = central.readUInt16LE(at + 30), comment = central.readUInt16LE(at + 32);
      const name = central.subarray(at + 46, at + 46 + length).toString('utf8');
      if (name === 'agent_skills_sample.db') {
        if (candidate || flags & 1 || ![0, 8].includes(method) || expanded > cap || compressed > cap) throw new Error('Unsafe or unsupported sample DB entry');
        const mode = central.readUInt32LE(at + 38) >>> 16;
        if ((mode & 0xf000) && (mode & 0xf000) !== 0x8000) throw new Error('Sample DB is not a regular file');
        candidate = { offset: central.readUInt32LE(at + 42), compressed, expanded, method };
      }
      at += 46 + length + extra + comment;
    }
    if (!candidate) throw new Error('Expected agent_skills_sample.db entry missing');
    const local = read(candidate.offset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid local ZIP header');
    const start = candidate.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (start + candidate.compressed > size) throw new Error('ZIP entry exceeds archive');
    const temporary = target + '.partial';
    let total = 0;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) { total += chunk.length; callback(total > cap || total > candidate!.expanded ? new Error('Expanded DB exceeds declared cap') : null, chunk); } });
    try {
      const input = createReadStream(archive, { start, end: start + candidate.compressed - 1 });
      if (candidate.method === 8) await pipeline(input, createInflateRaw(), limiter, createWriteStream(temporary));
      else await pipeline(input, limiter, createWriteStream(temporary));
      if (total !== candidate.expanded) throw new Error('Expanded DB length mismatch');
      renameSync(temporary, target);
    } catch (e) { if (existsSync(temporary)) unlinkSync(temporary); throw e; }
  } finally { closeSync(fd); }
}
async function fetchGitBlob(repository: string, sha: string, requireUtf8 = true): Promise<Buffer> {
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error(`Invalid Git blob SHA: ${sha}`);
    const url = `https://api.github.com/repos/${repository.split('/').map(encodeURIComponent).join('/')}/git/blobs/${sha}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'SkillGraph-Research', Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(60_000),
        });
        if (!response.ok || !response.body) throw new Error(`Git blob HTTP ${response.status} for ${repository}@${sha}`);
        const declaredLength = Number(response.headers.get('content-length') || 0);
        if (declaredLength > maxRepairBytes * 4 / 3 + 16_384) throw new Error(`Git blob response exceeds repair cap for ${repository}@${sha}`);
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxRepairBytes * 4 / 3 + 16_384) throw new Error(`Git blob response exceeds repair cap for ${repository}@${sha}`);
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { sha?: unknown; encoding?: unknown; content?: unknown; size?: unknown };
        if (payload.sha !== sha || payload.encoding !== 'base64' || typeof payload.content !== 'string') {
          throw new Error(`Unexpected Git blob response for ${repository}@${sha}`);
        }
        if (typeof payload.size !== 'number' || payload.size > maxRepairBytes) throw new Error(`Git blob exceeds ${maxRepairBytes}-byte repair cap or has no valid size`);
        const encoded = payload.content.replace(/\s/g, '');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
          throw new Error(`Invalid base64 in Git blob response for ${repository}@${sha}`);
        }
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length > maxRepairBytes || bytes.toString('base64') !== encoded) throw new Error(`Invalid or oversized Git blob for ${repository}@${sha}`);
        if (gitBlobHash(bytes) !== sha) throw new Error(`Git blob bytes do not reproduce SHA for ${repository}@${sha}`);
        if (requireUtf8) new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        return bytes;
      } catch (error) {
        lastError = error;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
    }
    throw lastError;
}

async function main() {
  if (args.includes('--help')) { console.log('Usage: node scripts/import-gitskills.ts --download [--download-only] | --source LOCAL.db [--db data/skillgraph.sqlite]. Imports all artifact occurrences and available representative sibling text. Source rows with missing bytes remain in an explicit unavailable-file table. Download is pinned, capped at 512 MiB per archive/DB, and never executes dataset content.'); return; }
  const data = join(project, 'data'); mkdirSync(data, { recursive: true });
  let source = argument('--source');
  if (args.includes('--download')) {
    const directory = join(data, 'gitskills-source'); mkdirSync(directory, { recursive: true });
    const archive = join(directory, `${sampleRevision}.zip`);
    source = join(directory, 'agent_skills_sample.db');
    console.log('DOWNLOAD pinned GitSkills sample'); await download(archive);
    const gitHash = await digest(archive, 'sha1', true);
    if (gitHash !== archiveBlob) throw new Error(`ZIP Git blob mismatch: ${gitHash}`);
    if (!existsSync(source)) { console.log('EXTRACT sample DB'); await extractDatabase(archive, source); }
    writeFileSync(join(directory, 'provenance.json'), JSON.stringify({ repository: sampleRepository, repositoryRevision: sampleRevision, sourceUrl, archiveBlob, archiveSha256: await digest(archive), archiveBytes: statSync(archive).size, database: source, databaseSha256: await digest(source), databaseBytes: statSync(source).size }, null, 2));
    console.log(`SOURCE ${source}`);
    if (args.includes('--download-only')) return;
  }
  if (!source) throw new Error('Use --download or --source LOCAL.db');
  source = resolve(source);
  if (statSync(source).size > cap) throw new Error('Source exceeds 512 MiB sample cap; full-dataset import is outside this bounded run');
  await importDatabase(source, resolve(project, argument('--db', 'data/skillgraph.sqlite')!));
}

async function importDatabase(sourcePath: string, targetPath: string) {
  const sourceHash = await digest(sourcePath);
  const revision = `dataset:gitskills-sample@${sourceHash}`;
  const input = new DatabaseSync(sourcePath, { readOnly: true });
  const check = input.prepare('PRAGMA quick_check').get();
  if (!check || Object.values(check)[0] !== 'ok') throw new Error('Source SQLite quick_check failed');
  const store = new SkillStore(targetPath);
  const provenance = new DatabaseSync(targetPath);
  provenance.exec(`PRAGMA busy_timeout=10000;
    CREATE TABLE IF NOT EXISTS dataset_imports (revision TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_sha256 TEXT NOT NULL, provenance_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dataset_file_provenance (revision TEXT NOT NULL, source_table TEXT NOT NULL, source_key TEXT NOT NULL, file_id TEXT, repository TEXT NOT NULL, path TEXT NOT NULL, source_blob_sha TEXT, status TEXT NOT NULL, metadata_json TEXT NOT NULL, PRIMARY KEY(revision,source_table,source_key));
    CREATE INDEX IF NOT EXISTS dataset_provenance_status ON dataset_file_provenance(revision,status);
    CREATE INDEX IF NOT EXISTS dataset_provenance_file ON dataset_file_provenance(file_id);
  `);
  const sourceMetadataPath = join(dirname(sourcePath), 'provenance.json');
  const downloaded = existsSync(sourceMetadataPath) ? JSON.parse(readFileSync(sourceMetadataPath, 'utf8')) : null;
  const counts = input.prepare('SELECT COUNT(*) artifacts,COUNT(DISTINCT file_sha) distinctContents,COUNT(DISTINCT repo_full_name) repositories FROM artifacts').get()!;
  const siblingCounts = input.prepare('SELECT COUNT(*) rows,SUM(entry_type = \'file\') files,SUM(content IS NOT NULL) texts FROM artifact_siblings').get()!;
  const report = {
    schemaVersion: 1, startedAt: new Date().toISOString(), updatedAt: '', status: 'running', datasetRevision: revision,
    source: { path: sourcePath, sha256: sourceHash, bytes: statSync(sourcePath).size, download: downloaded },
    scope: 'Every artifact occurrence and every supplied sibling record in this bounded sample, not all GitHub. Representative skill text may be reused only for identical verified blob hashes; sibling files are never assigned to other copies.',
    sourceCounts: { ...counts, siblings: siblingCounts }, importedArtifacts: 0, importedSiblingRows: 0, unavailableArtifactRows: 0,
    siblingDirectories: 0, unavailableSiblingRows: 0, failedRows: 0, verifiedSkillHashes: 0,
    repairedArtifactRows: [] as { repository: string; path: string; gitBlobSha: string; source: string }[],
    repairedSiblingRows: [] as { repository: string; path: string; gitBlobSha: string; source: string }[],
    integrityFailures: [] as { table: string; repository: string; path: string; error: string }[],
    coverage: { artifactContentsComplete: false, siblingContentsComplete: false, upstreamRepositoryCommitsAvailable: false,
      note: 'The dataset has file blob hashes and observation timestamps, not upstream repository commit IDs. Missing sibling content and directory entries are retained in dataset_file_provenance; source DB retains all original metadata. No sibling coverage is inferred for non-representative copies.' },
  };
  const reportPath = join(dirname(targetPath), 'gitskills-import.json');
  const save = () => { report.updatedAt = new Date().toISOString(); writeFileSync(reportPath, JSON.stringify(report, null, 2)); };
  provenance.prepare('INSERT OR REPLACE INTO dataset_imports VALUES(?,?,?,?)').run(revision, sourcePath, sourceHash, JSON.stringify({ downloaded, counts, siblingCounts, upstreamRepositoryCommitsAvailable: false }));
  const record = provenance.prepare('INSERT OR REPLACE INTO dataset_file_provenance VALUES(?,?,?,?,?,?,?,?,?)');
  const verified = new Map<string, boolean>();
  const repairedBlobs = new Map<string, Buffer>();
  type Row = Record<string, string | number | null>;
  const addRecord = (table: string, key: string, row: Row, path: string, blob: string | null, status: string, fileId: string | null, metadata: object) => record.run(revision, table, key, fileId, String(row.repo_full_name), path, blob, status, JSON.stringify(metadata));
  const artifactSql = `SELECT a.*,p.content AS representative_content,p.repo_full_name AS representative_repository,p.path AS representative_path
    FROM artifacts a LEFT JOIN artifacts p ON p.file_sha=a.file_sha AND p.dedup_primary=1 ORDER BY a.repo_full_name,a.path`;
  try {
    save();
    for (const raw of input.prepare(artifactSql).iterate()) {
      const row = raw as Row, repository = String(row.repo_full_name), path = String(row.path), blob = String(row.file_sha);
      const key = JSON.stringify([repository, path]);
      const metadata = { discoveredAt: row.discovered_at, filename: row.filename, locationClass: row.location_class,
        dedupPrimary: row.dedup_primary, compositionFetched: row.composition_fetched, compositionTruncated: row.composition_truncated,
        representativeRepository: row.representative_repository, representativePath: row.representative_path,
        siblingCoverage: row.dedup_primary === 1 ? 'source_representative_only' : 'unknown_for_this_copy' };
      try {
        const text = row.content ?? row.representative_content;
        if (typeof text !== 'string') { report.unavailableArtifactRows++; addRecord('artifacts', key, row, path, blob, 'content_unavailable', null, metadata); continue; }
        let bytes: Buffer = Buffer.from(text, 'utf8');
        let repaired = false;
        // Verify every supplied occurrence text; representative bytes are cached only by verified Git blob hash.
        const canonical = repairedBlobs.get(blob);
        if (row.content === null && canonical) { bytes = canonical; repaired = true; }
        const shouldVerify = row.content !== null || !verified.has(blob) || Boolean(canonical);
        if (shouldVerify && gitBlobHash(bytes) !== blob) {
          if (canonical) { bytes = canonical; repaired = true; }
          else {
            bytes = await fetchGitBlob(repository, blob);
            repairedBlobs.set(blob, bytes);
            repaired = true;
          }
        }
        if (gitBlobHash(bytes) !== blob) throw new Error('Skill bytes do not reproduce source Git blob hash after repair');
        if (!verified.has(blob)) { verified.set(blob, true); report.verifiedSkillHashes++; }
        const fileId = store.importFile({ repository, commit: revision, path, packagePath: posix.dirname(path) === '.' ? '' : posix.dirname(path), kind: 'skill', content: bytes });
        if (repaired) report.repairedArtifactRows.push({ repository, path, gitBlobSha: blob, source: `GitHub Git Blob API: ${repository}@${blob}` });
        addRecord('artifacts', key, row, path, blob, repaired ? 'imported_verified_repaired_from_git_blob' : 'imported_verified', fileId,
          repaired ? { ...metadata, canonicalSource: `GitHub Git Blob API: ${repository}@${blob}` } : metadata);
        report.importedArtifacts++;
      } catch (e) { const error = errorText(e); report.failedRows++; report.integrityFailures.push({ table: 'artifacts', repository, path, error }); addRecord('artifacts', key, row, path, blob, 'failed', null, { ...metadata, error }); }
      if ((report.importedArtifacts + report.failedRows + report.unavailableArtifactRows) % 1000 === 0) { console.log(`ARTIFACTS ${report.importedArtifacts}/${counts.artifacts}`); save(); }
    }
    for (const raw of input.prepare('SELECT * FROM artifact_siblings ORDER BY repo_full_name,artifact_path,entry_name').iterate()) {
      const row = raw as Row, repository = String(row.repo_full_name), artifactPath = String(row.artifact_path), name = String(row.entry_name);
      const base = posix.dirname(artifactPath), path = posix.join(base, name), key = JSON.stringify([repository, artifactPath, name]);
      const blob = typeof row.entry_sha === 'string' ? row.entry_sha : null;
      const metadata = { artifactPath, entryName: name, entryType: row.entry_type, entrySize: row.entry_size, contentFetched: row.content_fetched, skippedReason: row.skipped_reason, representativeOnly: true };
      try {
        if (/^[\\/]|^[A-Za-z]:/.test(name) || name.includes('\\') || name.split('/').includes('..')) throw new Error('Unsafe sibling relative path');
        if (row.entry_type === 'dir') { report.siblingDirectories++; addRecord('artifact_siblings', key, row, path, blob, 'directory_inventory_only', null, metadata); continue; }
        if (typeof row.content !== 'string') { report.unavailableSiblingRows++; addRecord('artifact_siblings', key, row, path, blob, 'content_unavailable', null, metadata); continue; }
        if (row.entry_type !== 'file') throw new Error(`Unsupported sibling entry type ${row.entry_type}`);
        let bytes: Buffer = Buffer.from(row.content, 'utf8');
        let repaired = false;
        if (!blob) throw new Error('Sibling source Git blob hash is unavailable');
        if (gitBlobHash(bytes) !== blob) {
          let canonical = repairedBlobs.get(blob);
          if (!canonical) {
            canonical = await fetchGitBlob(repository, blob, false);
            repairedBlobs.set(blob, canonical);
          }
          bytes = canonical;
          repaired = true;
        }
        if (gitBlobHash(bytes) !== blob) throw new Error('Sibling bytes do not reproduce source Git blob hash after repair');
        // A sibling path can itself be an artifact. Preserve the existing artifact's kind/package.
        const existing = provenance.prepare('SELECT id,hash FROM files WHERE repository=? AND commit_sha=? AND path=?').get(repository, revision, path);
        let fileId: string;
        if (existing) {
          if (String(existing.hash) !== createHash('sha256').update(bytes).digest('hex')) throw new Error('Conflicting sibling content at an existing source path');
          fileId = String(existing.id);
        } else fileId = store.importFile({ repository, commit: revision, path, packagePath: base === '.' ? '' : base, kind: 'reference', content: bytes });
        if (repaired) report.repairedSiblingRows.push({ repository, path, gitBlobSha: blob, source: `GitHub Git Blob API: ${repository}@${blob}` });
        addRecord('artifact_siblings', key, row, path, blob, repaired ? 'imported_verified_repaired_from_git_blob' : 'imported_verified', fileId,
          repaired ? { ...metadata, canonicalSource: `GitHub Git Blob API: ${repository}@${blob}` } : metadata);
        report.importedSiblingRows++;
      } catch (e) { const error = errorText(e); report.failedRows++; report.integrityFailures.push({ table: 'artifact_siblings', repository, path, error }); addRecord('artifact_siblings', key, row, path, blob, 'failed', null, { ...metadata, error }); }
      if (report.importedSiblingRows % 1000 === 0) { console.log(`SIBLINGS ${report.importedSiblingRows}/${siblingCounts.texts}`); save(); }
    }
    report.coverage.artifactContentsComplete = report.importedArtifacts === Number(counts.artifacts);
    report.coverage.siblingContentsComplete = report.unavailableSiblingRows === 0 && report.failedRows === 0;
    report.status = report.failedRows ? 'partial_with_integrity_failures' : report.unavailableArtifactRows || report.unavailableSiblingRows || report.siblingDirectories ? 'sample_imported_with_explicit_source_gaps' : 'complete';
    save();
    console.log(JSON.stringify({ report: reportPath, status: report.status, importedArtifacts: report.importedArtifacts, importedSiblingRows: report.importedSiblingRows, unavailableSiblingRows: report.unavailableSiblingRows, failedRows: report.failedRows }));
    if (report.failedRows) process.exitCode = 1;
  } finally { provenance.close(); store.close(); input.close(); }
}
main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
