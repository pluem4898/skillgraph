import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';

const VERSION = 'rea-inventory-view-v2';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type Member = { occurrence_id: string; logical_path: string; parent_occurrence_id: string | null;
  entry_kind: string; artifact_id: string; declared_size: number | null; hash_status: string; encrypted: boolean };
type Inventory = { manifest: { root_sha256: string; node_count: number; occurrence_count: number; edge_count: number };
  nodes: { artifact_id: string; sha256: string }[]; occurrences: Member[];
  coverage: unknown; limitations: unknown; integrity_contradictions: unknown[] };
export type EvidenceQuery = { view: 'summary' | 'extensions' | 'files' | 'record'; extension?: string; offset?: number; limit?: number; index?: number };
type NormalizedQuery = { view: 'summary' } | { view: 'extensions' } | { view: 'record'; index: number } |
  { view: 'files'; extension?: string; offset: number; limit: number };
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }); }
function atomic(path: string, text: string | Uint8Array) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, text, { flag: 'wx' }); renameSync(temporary, path);
}
function normalize(query: EvidenceQuery): NormalizedQuery {
  if (!['summary', 'extensions', 'files', 'record'].includes(query.view)) fail('INVALID_VIEW', 'Use summary, extensions, files or record');
  if (query.view === 'record') {
    if (!Number.isSafeInteger(query.index) || query.index! < 0 || query.extension !== undefined || query.offset !== undefined || query.limit !== undefined) fail('INVALID_QUERY', 'Record requires a nonnegative --index only');
    return { view: query.view, index: query.index! };
  }
  if (query.index !== undefined) fail('INVALID_QUERY', 'Index applies to record only');
  if (query.view !== 'files' && (query.extension !== undefined || query.offset !== undefined || query.limit !== undefined)) fail('INVALID_QUERY', 'Filters and paging apply to files only');
  if (query.view === 'summary') return { view: 'summary' };
  if (query.view === 'extensions') return { view: 'extensions' };
  const offset = query.offset ?? 0, limit = query.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1) fail('INVALID_QUERY', 'Invalid whole-record offset or limit');
  if (query.extension !== undefined && !/^\.[^/\\\s]+$/.test(query.extension)) fail('INVALID_QUERY', 'Expected an extension such as .gd');
  return { view: query.view, ...(query.extension === undefined ? {} : { extension: query.extension.toLowerCase() }), offset, limit };
}
function inventory(document: any): { evidenceId: string; data: Inventory; pointer: string } {
  if (!document || typeof document.evidence_id !== 'string') fail('UNSUPPORTED_EVIDENCE', 'Expected a REA evidence record');
  const stepIndex = document.normalized_result?.substeps?.findIndex((step: any) => step.operation === 'inventory_artifact');
  const data = document.operation === 'inventory_artifact' ? document.normalized_result :
    document.operation === 'inspect_artifact' ? document.normalized_result?.substeps?.find((step: any) => step.operation === 'inventory_artifact')?.evidence?.normalized_result : undefined;
  if (!data?.manifest || !Array.isArray(data.nodes) || !Array.isArray(data.occurrences) || !Array.isArray(data.edges) || !Array.isArray(data.integrity_contradictions) || !Array.isArray(data.limitations) || !data.coverage) fail('UNSUPPORTED_EVIDENCE', 'Missing artifact inventory fields');
  if (data.manifest.node_count !== data.nodes.length || data.manifest.occurrence_count !== data.occurrences.length || data.manifest.edge_count !== data.edges.length) fail('INVALID_EVIDENCE', 'Manifest counts disagree with retained arrays');
  const ids = new Set<string>();
  for (const node of data.nodes) {
    if (typeof node.artifact_id !== 'string' || !/^[a-f0-9]{64}$/.test(node.sha256) || ids.has(node.artifact_id)) fail('INVALID_EVIDENCE', 'Invalid or duplicate artifact node');
    ids.add(node.artifact_id);
  }
  const occurrences = new Set<string>();
  for (const item of data.occurrences) {
    if (typeof item.logical_path !== 'string' || typeof item.entry_kind !== 'string' || typeof item.hash_status !== 'string' || typeof item.encrypted !== 'boolean' ||
      typeof item.occurrence_id !== 'string' || occurrences.has(item.occurrence_id) || !ids.has(item.artifact_id) ||
      !(item.parent_occurrence_id === null || typeof item.parent_occurrence_id === 'string') ||
      !(item.declared_size === null || Number.isSafeInteger(item.declared_size) && item.declared_size >= 0)) fail('INVALID_EVIDENCE', 'Invalid occurrence record');
    occurrences.add(item.occurrence_id);
  }
  if (data.occurrences.some((item: Member) => item.parent_occurrence_id !== null && !occurrences.has(item.parent_occurrence_id))) fail('INVALID_EVIDENCE', 'Unknown parent occurrence');
  return { evidenceId: document.evidence_id, data,
    pointer: document.operation === 'inspect_artifact' ? `/normalized_result/substeps/${stepIndex}/evidence/normalized_result` : '/normalized_result' };
}

/** Pure projections of existing observations, not new analysis of executable code.
 * Full input is retained; filtering applies to evidence rows, never skill discovery. */
export function queryEvidence(input: string, query: EvidenceQuery, cacheDirectory?: string) {
  const normalized = normalize(query);
  if (statSync(input).size > 128 * 1024 * 1024) fail('INPUT_TOO_LARGE', 'Evidence input exceeds 128 MiB; no partial read was made');
  const bytes = readFileSync(input), sourceHash = hash(bytes);
  const key = hash(JSON.stringify([VERSION, sourceHash, normalized]));
  let cachePath: string | undefined;
  if (cacheDirectory) {
    mkdirSync(cacheDirectory, { recursive: true });
    const snapshot = join(cacheDirectory, sourceHash + '.source.json');
    if (existsSync(snapshot)) {
      if (hash(readFileSync(snapshot)) !== sourceHash) fail('CACHE_CORRUPTED', 'Retained source digest mismatch');
    } else atomic(snapshot, bytes);
    cachePath = join(cacheDirectory, key + '.view.json');
    if (existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
        if (cached.key !== key || cached.version !== VERSION || cached.sourceHash !== sourceHash || hash(JSON.stringify(cached.payload)) !== cached.payloadHash) fail('CACHE_CORRUPTED', 'Cached view digest mismatch');
        return { ...cached.payload, cacheHit: true };
      } catch (error) { fail('CACHE_CORRUPTED', error instanceof Error ? error.message : String(error)); }
    }
  }
  let document;
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '')); }
  catch { fail('INVALID_EVIDENCE', 'Evidence is not valid UTF-8 JSON'); }
  const { evidenceId, data, pointer } = inventory(document);
  const members = data.occurrences.filter(member => member.parent_occurrence_id !== null);
  const files = members.filter(member => member.entry_kind === 'file');
  let answer: unknown;
  if (normalized.view === 'summary') answer = {
    rootSha256: data.manifest.root_sha256, nodes: data.nodes.length, occurrences: data.occurrences.length,
    members: members.length, files: files.length, directories: members.filter(m => m.entry_kind === 'directory').length,
    otherEntries: members.filter(m => m.entry_kind !== 'file' && m.entry_kind !== 'directory').length,
    declaredFileBytes: files.reduce((sum, file) => sum + (file.declared_size ?? 0), 0),
    unknownFileSizes: files.filter(file => file.declared_size === null).length,
    unverifiedMembers: members.filter(file => file.hash_status !== 'verified').length,
    encryptedMembers: members.filter(file => file.encrypted).length,
    integrityContradictions: data.integrity_contradictions,
  };
  else if (normalized.view === 'extensions') {
    const counts = new Map<string, number>();
    for (const file of files) { const ext = posix.extname(file.logical_path).toLowerCase(); counts.set(ext, (counts.get(ext) ?? 0) + 1); }
    answer = [...counts].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([extension, count]) => ({ extension, count }));
  } else if (normalized.view === 'record') {
    const occurrence = data.occurrences[normalized.index];
    if (!occurrence) fail('INVALID_QUERY', 'Record index is beyond retained occurrences');
    answer = { occurrence, artifact: data.nodes.find(node => node.artifact_id === occurrence.artifact_id) };
  } else {
    const selected = files.filter(file => !normalized.extension || posix.extname(file.logical_path).toLowerCase() === normalized.extension)
      .sort((a, b) => Buffer.compare(Buffer.from(a.logical_path), Buffer.from(b.logical_path)) || Buffer.compare(Buffer.from(a.occurrence_id), Buffer.from(b.occurrence_id)));
    const hashes = new Map(data.nodes.map(node => [node.artifact_id, node.sha256]));
    const indices = new Map(data.occurrences.map((member, index) => [member.occurrence_id, index]));
    const offset = normalized.offset!, limit = normalized.limit!;
    if (offset > selected.length) fail('INVALID_QUERY', 'Offset is beyond selected records');
    const items = selected.slice(offset, offset + limit).map(file => ({ path: file.logical_path, bytes: file.declared_size, sha256: hashes.get(file.artifact_id), sourceIndex: indices.get(file.occurrence_id) }));
    answer = { total: selected.length, offset, nextOffset: offset + items.length < selected.length ? offset + items.length : null, items };
  }
  const payload = { sourceHash, evidenceId, query: normalized, coverage: data.coverage, limitations: data.limitations,
    pathWarnings: { backslashPaths: members.filter(file => file.logical_path.includes('\\')).length,
      backslashTerminatedFileEntries: files.filter(file => file.logical_path.endsWith('\\')).length },
    evidencePointer: pointer, answer };
  if (cachePath) atomic(cachePath, JSON.stringify({ key, version: VERSION, sourceHash, payloadHash: hash(JSON.stringify(payload)), payload }));
  return { ...payload, cacheHit: false };
}
