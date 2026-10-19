import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, posix } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getEncoding } from 'js-tiktoken';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { parseDocument } from 'yaml';

export type FileKind = 'skill' | 'reference' | 'asset';
export type Heading = { title: string; level: number; startLine: number; endLine: number };
export type SourceLink = { target: string; line: number };
export type ResolvedLink = SourceLink & {
  status: 'resolved' | 'missing' | 'external' | 'outside_repository' | 'anchor';
  resolvedPath?: string;
  fileId?: string;
};
export type ParsedSkill = { name: string; description: string; headings: Heading[]; links: SourceLink[]; errors: string[] };
export type SkillMetadata = {
  id: string; repository: string; commit: string; path: string; packagePath: string;
  kind: FileKind; hash: string; size: number; totalLines: number;
  name: string | null; description: string | null; headings: Heading[];
  links: ResolvedLink[]; errors: string[]; encoding: 'utf-8' | 'binary';
};
export type SkillFile = SkillMetadata & { text: string | null };
export type FilePage = { items: SkillMetadata[]; total: number; nextOffset: number | null };
export type CatalogPage = {
  /** JSON Lines: first line declares columns; following lines are complete entries. */
  text: string; total: number; returned: number; offset: number; nextOffset: number | null;
  /** True only when this response contains the entire catalog, starting at offset 0. */
  complete: boolean; catalogHash: string; tokenCount: number;
  format: 'full' | 'compact';
};
export type ImportFile = {
  repository: string; commit: string; path: string; packagePath: string;
  content: Buffer; kind: FileKind;
};
export class SkillStoreError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'SkillStoreError';
    this.code = code;
    this.details = details;
  }
}

const encoder = getEncoding('o200k_base');
/** Count arbitrary source text, including literal token-control strings, as ordinary text. */
export function tokenize(text: string): number { return encoder.encode(text, [], []).length; }
const sha256 = (content: string | Uint8Array) => createHash('sha256').update(content).digest('hex');

/** Source lines retain their original CRLF/LF/CR terminators; no phantom line after EOF. */
function sourceLines(text: string): string[] {
  if (!text.length) return [];
  return text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
}
const withoutEol = (text: string) => text.replace(/(?:\r\n|\r|\n)$/, '');
type MdNode = {
  type: string; value?: string; depth?: number; url?: string; identifier?: string;
  children?: MdNode[]; position?: { start: { line: number }; end: { line: number } };
};
function nodeText(node: MdNode): string {
  return node.value ?? node.children?.map(nodeText).join('') ?? '';
}

/** Parse only data. Markdown code fences are never interpreted as headings or executed. */
export function parseSkill(text: string): ParsedSkill {
  const result: ParsedSkill = { name: '', description: '', headings: [], links: [], errors: [] };
  const lines = sourceLines(text);
  let bodyStart = 0;
  if (withoutEol(lines[0] ?? '').replace(/^\uFEFF/, '') === '---') {
    const closing = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(withoutEol(line)));
    if (closing < 0) {
      result.errors.push('FRONTMATTER_UNCLOSED: opening --- has no closing delimiter');
    } else {
      bodyStart = closing + 1;
      const yaml = lines.slice(1, closing).join('');
      const doc = parseDocument(yaml, { uniqueKeys: true, strict: true });
      for (const error of doc.errors) result.errors.push(`YAML_INVALID: ${error.message}`);
      for (const warning of doc.warnings) result.errors.push(`YAML_WARNING: ${warning.message}`);
      for (const field of ['name', 'description'] as const) {
        try {
          const value = doc.get(field);
          if (typeof value === 'string') result[field] = value;
          else if (value !== undefined && value !== null) result.errors.push(`METADATA_TYPE: ${field} must be a string`);
        } catch (error) {
          result.errors.push(`METADATA_UNREADABLE: ${field}: ${String(error)}`);
        }
      }
    }
  } else {
    result.errors.push('FRONTMATTER_MISSING: no YAML frontmatter');
  }
  if (!result.name) result.errors.push('NAME_MISSING: skill name is empty or unavailable');
  if (!result.description) result.errors.push('DESCRIPTION_MISSING: skill description is empty or unavailable');
  const tree = fromMarkdown(lines.slice(bodyStart).join('')) as MdNode;
  const definitions = new Map<string, string>();
  const visit = (node: MdNode, callback: (n: MdNode) => void) => {
    callback(node);
    for (const child of node.children ?? []) visit(child, callback);
  };
  visit(tree, (node) => {
    if (node.type === 'definition' && node.identifier && node.url) definitions.set(node.identifier, node.url);
  });
  visit(tree, (node) => {
    const line = (node.position?.start.line ?? 1) + bodyStart;
    if (node.type === 'heading') result.headings.push({ title: nodeText(node), level: node.depth!, startLine: line, endLine: lines.length });
    if ((node.type === 'link' || node.type === 'image') && node.url !== undefined) result.links.push({ target: node.url, line });
    if ((node.type === 'linkReference' || node.type === 'imageReference') && node.identifier) {
      const target = definitions.get(node.identifier);
      if (target !== undefined) result.links.push({ target, line });
    }
  });
  for (let i = 0; i < result.headings.length; i++) {
    const next = result.headings.slice(i + 1).find((h) => h.level <= result.headings[i].level);
    if (next) result.headings[i].endLine = next.startLine - 1;
  }
  return result;
}

type DbRow = Record<string, string | number | null | Uint8Array>;
type CatalogSnapshot = { ids: string[]; entries: string[]; entryTokens: (number | undefined)[]; text: string; hash: string; tokenCount?: number; compactEntries?: string[]; compactEntryTokens?: (number | undefined)[] };
const catalogHeader = JSON.stringify(['id', 'name', 'description', 'path', 'hash', 'errors']) + '\n';
const compactCatalogHeader = JSON.stringify(['handle', 'name', 'description', 'path', 'errors']) + '\n';
function pathInRepository(path: string, allowEmpty = false): string {
  if (typeof path !== 'string' || path.includes('\0') || /^[a-zA-Z]:|^[\\/]/.test(path)) {
    throw new SkillStoreError('INVALID_PATH', 'Expected a relative repository path', { path });
  }
  const normalized = posix.normalize(path.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) throw new SkillStoreError('INVALID_PATH', 'Path escapes repository', { path });
  if (normalized === '.' && allowEmpty) return '';
  if (normalized === '.' || normalized === '') throw new SkillStoreError('INVALID_PATH', 'File path cannot be empty', { path });
  return normalized;
}
function nonnegative(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new SkillStoreError('INVALID_ARGUMENT', `${field} must be a nonnegative integer`);
  return value;
}

/** Immutable file snapshots with content-addressed byte storage. Importing never executes files. */
export class SkillStore {
  private db: DatabaseSync;
  private catalogCache = new Map<string | undefined, CatalogSnapshot>();
  private catalogDataVersion = -1;
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 10000;
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY, content BLOB NOT NULL, text TEXT, encoding TEXT NOT NULL,
        size INTEGER NOT NULL, total_lines INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, repository TEXT NOT NULL, commit_sha TEXT NOT NULL,
        path TEXT NOT NULL, package_path TEXT NOT NULL, kind TEXT NOT NULL,
        hash TEXT NOT NULL REFERENCES blobs(hash), name TEXT, description TEXT,
        headings_json TEXT NOT NULL, links_json TEXT NOT NULL, errors_json TEXT NOT NULL,
        UNIQUE(repository, commit_sha, path)
      );
      CREATE INDEX IF NOT EXISTS files_kind_repository ON files(kind, repository, id);
      CREATE INDEX IF NOT EXISTS files_package ON files(repository, commit_sha, package_path);
    `);
  }

  importFile(input: ImportFile): string {
    const { repository, commit, content, kind } = input;
    if (!repository || !commit || !Buffer.isBuffer(content) || !['skill', 'reference', 'asset'].includes(kind)) {
      throw new SkillStoreError('INVALID_ARGUMENT', 'repository, commit, Buffer content and a supported kind are required');
    }
    const path = pathInRepository(input.path);
    const packagePath = pathInRepository(input.packagePath, true);
    const id = sha256(JSON.stringify([repository, commit, path]));
    const hash = sha256(content);
    const existing = this.db.prepare('SELECT hash, kind, package_path FROM files WHERE id = ?').get(id) as DbRow | undefined;
    if (existing) {
      if (existing.hash !== hash || existing.kind !== kind || existing.package_path !== packagePath) {
        throw new SkillStoreError('SNAPSHOT_CONFLICT', 'An immutable repository/commit/path snapshot already contains different content or metadata', { id });
      }
      return id;
    }
    let text: string | null = null;
    const errors: string[] = [];
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
      if (text.includes('\0')) { text = null; errors.push('BINARY_CONTENT: source contains NUL bytes'); }
    } catch {
      errors.push('INVALID_UTF8: bytes preserved; source cannot be read as UTF-8 text');
    }
    let parsed: ParsedSkill = { name: '', description: '', headings: [], links: [], errors: [] };
    if (text !== null && (kind === 'skill' || /\.(md|mdx|markdown)$/i.test(path))) {
      parsed = parseSkill(text);
      if (kind !== 'skill') parsed.errors = parsed.errors.filter((error) => !/^(FRONTMATTER_MISSING|NAME_MISSING|DESCRIPTION_MISSING):/.test(error));
    }
    errors.push(...parsed.errors);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR IGNORE INTO blobs(hash,content,text,encoding,size,total_lines) VALUES(?,?,?,?,?,?)')
        .run(hash, content, text, text === null ? 'binary' : 'utf-8', content.length, text === null ? 0 : sourceLines(text).length);
      this.db.prepare(`INSERT INTO files(id,repository,commit_sha,path,package_path,kind,hash,name,description,headings_json,links_json,errors_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, repository, commit, path, packagePath, kind, hash,
        kind === 'skill' ? parsed.name : null, kind === 'skill' ? parsed.description : null,
        JSON.stringify(parsed.headings), JSON.stringify(parsed.links), JSON.stringify(errors));
      this.db.exec('COMMIT');
      this.catalogCache.clear();
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return id;
  }

  private resolveLink(link: SourceLink, file: Pick<SkillMetadata, 'repository' | 'commit' | 'path'>): ResolvedLink {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(link.target)) return { ...link, status: 'external' };
    if (link.target.startsWith('#') || !link.target) return { ...link, status: 'anchor' };
    let target = link.target.split(/[?#]/, 1)[0];
    try { target = decodeURIComponent(target); } catch { /* Preserve malformed URL for a visible missing status. */ }
    if (/^[\\/]/.test(target)) return { ...link, status: 'outside_repository' };
    const resolvedPath = posix.normalize(posix.join(posix.dirname(file.path), target.replaceAll('\\', '/')));
    if (resolvedPath === '..' || resolvedPath.startsWith('../')) return { ...link, status: 'outside_repository', resolvedPath };
    const targetRow = this.db.prepare('SELECT id FROM files WHERE repository = ? AND commit_sha = ? AND path = ?')
      .get(file.repository, file.commit, resolvedPath) as DbRow | undefined;
    return { ...link, resolvedPath, status: targetRow ? 'resolved' : 'missing', ...(targetRow ? { fileId: String(targetRow.id) } : {}) };
  }

  private metadata(row: DbRow): SkillMetadata {
    const file: SkillMetadata = {
      id: String(row.id), repository: String(row.repository), commit: String(row.commit_sha),
      path: String(row.path), packagePath: String(row.package_path), kind: row.kind as FileKind,
      hash: String(row.hash), size: Number(row.size), totalLines: Number(row.total_lines),
      name: row.name === null ? null : String(row.name), description: row.description === null ? null : String(row.description),
      headings: JSON.parse(String(row.headings_json)), links: [], errors: JSON.parse(String(row.errors_json)),
      encoding: row.encoding as 'utf-8' | 'binary',
    };
    file.links = (JSON.parse(String(row.links_json)) as SourceLink[]).map((link) => this.resolveLink(link, file));
    return file;
  }

  listSkills(options: { repository?: string; offset?: number; limit?: number } = {}): FilePage {
    return this.listFiles({ ...options, kind: 'skill' });
  }

  listFiles(options: { repository?: string; packagePath?: string; kind?: FileKind; offset?: number; limit?: number } = {}): FilePage {
    const offset = nonnegative(options.offset ?? 0, 'offset');
    const limit = nonnegative(options.limit ?? 100, 'limit');
    if (limit < 1) throw new SkillStoreError('INVALID_ARGUMENT', 'limit must be at least 1');
    const clauses: string[] = [];
    const args: string[] = [];
    for (const [column, value] of [['repository', options.repository], ['package_path', options.packagePath], ['kind', options.kind]]) {
      if (value !== undefined) { clauses.push(`f.${column} = ?`); args.push(value); }
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const count = this.db.prepare(`SELECT COUNT(*) AS total FROM files f ${where}`).get(...args) as DbRow;
    const total = Number(count.total);
    const rows = this.db.prepare(`SELECT f.*,b.size,b.total_lines,b.encoding FROM files f JOIN blobs b ON b.hash = f.hash ${where} ORDER BY f.id LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as DbRow[];
    const items = rows.map((row) => this.metadata(row));
    return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
  }

  getFile(id: string): SkillFile {
    const row = this.db.prepare('SELECT f.*,b.content,b.text,b.size,b.total_lines,b.encoding FROM files f JOIN blobs b ON b.hash = f.hash WHERE f.id = ?').get(id) as DbRow | undefined;
    if (!row) throw new SkillStoreError('FILE_NOT_FOUND', 'Unknown file ID', { id });
    if (sha256(row.content as Uint8Array) !== row.hash) throw new SkillStoreError('CONTENT_CORRUPTED', 'Stored source bytes do not match the citation hash', { id });
    const text = row.text === null ? null : String(row.text);
    if (text !== null && !Buffer.from(text, 'utf8').equals(Buffer.from(row.content as Uint8Array))) {
      throw new SkillStoreError('CONTENT_CORRUPTED', 'Stored decoded text differs from source bytes', { id });
    }
    return { ...this.metadata(row), text };
  }

  readLines(id: string, start: number, end: number, expectedHash?: string): {
    fileId: string; hash: string; startLine: number; endLine: number; totalLines: number; text: string; numberedText: string;
  } {
    const file = this.getFile(id);
    if (expectedHash !== undefined && expectedHash !== file.hash) throw new SkillStoreError('STALE_CITATION', 'Expected hash does not match this file snapshot', { expectedHash, actualHash: file.hash });
    if (file.text === null) throw new SkillStoreError('BINARY_CONTENT', 'Source bytes are preserved but are not UTF-8 text', { id });
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > file.totalLines) {
      throw new SkillStoreError('INVALID_LINE_RANGE', `Expected 1 <= start <= end <= ${file.totalLines}`, { start, end, totalLines: file.totalLines });
    }
    const lines = sourceLines(file.text).slice(start - 1, end);
    return { fileId: file.id, hash: file.hash, startLine: start, endLine: end, totalLines: file.totalLines,
      text: lines.join(''), numberedText: lines.map((line, i) => `${start + i}|${line}`).join('') };
  }

  private snapshotForRepository(repository?: string): CatalogSnapshot {
    const dataVersion = Number((this.db.prepare('PRAGMA data_version').get() as DbRow).data_version);
    if (dataVersion !== this.catalogDataVersion) { this.catalogCache.clear(); this.catalogDataVersion = dataVersion; }
    let snapshot = this.catalogCache.get(repository);
    if (!snapshot) {
      const args = repository === undefined ? [] : [repository];
      const rows = this.db.prepare(`SELECT id,name,description,path,hash,errors_json FROM files WHERE kind = 'skill' ${args.length ? 'AND repository = ?' : ''} ORDER BY id`).all(...args) as DbRow[];
      const entries = rows.map((row) => JSON.stringify([row.id, row.name, row.description, row.path, row.hash, JSON.parse(String(row.errors_json))]) + '\n');
      const text = catalogHeader + entries.join('');
      snapshot = { ids: rows.map((r) => String(r.id)), entries, entryTokens: [], text, hash: sha256(text) };
      this.catalogCache.set(repository, snapshot);
    }
    return snapshot;
  }

  catalog(options: { repository?: string; offset?: number; maxTokens?: number } = {}): CatalogPage {
    return this.catalogPage(options, false);
  }

  /** Reversible handles remove repeated hashes, while all discovery text stays exact. */
  compactCatalog(options: { repository?: string; offset?: number; maxTokens?: number } = {}): CatalogPage {
    return this.catalogPage(options, true);
  }

  resolveHandle(handle: string, catalogHash: string, repository?: string): SkillMetadata {
    const snapshot = this.snapshotForRepository(repository);
    if (catalogHash !== snapshot.hash) throw new SkillStoreError('STALE_CATALOG', 'Catalog changed or scope differs; restart enumeration.', { actualHash: snapshot.hash });
    if (!/^s[1-9][0-9]*$/.test(handle)) throw new SkillStoreError('INVALID_HANDLE', 'Expected a handle such as s1');
    const index = Number(handle.slice(1)) - 1;
    if (!Number.isSafeInteger(index) || index >= snapshot.ids.length) throw new SkillStoreError('INVALID_HANDLE', 'Handle is outside this catalog');
    const { text: _text, ...metadata } = this.getFile(snapshot.ids[index]);
    return metadata;
  }

  private catalogPage(options: { repository?: string; offset?: number; maxTokens?: number }, compact: boolean): CatalogPage {
    const offset = nonnegative(options.offset ?? 0, 'offset');
    if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1)) {
      throw new SkillStoreError('INVALID_ARGUMENT', 'maxTokens must be a positive integer');
    }
    const snapshot = this.snapshotForRepository(options.repository);
    if (compact && !snapshot.compactEntries) {
      snapshot.compactEntries = snapshot.entries.map((entry, i) => {
        const row = JSON.parse(entry);
        return JSON.stringify([`s${i + 1}`, row[1], row[2], row[3], row[5]]) + '\n';
      });
      snapshot.compactEntryTokens = [];
    }
    const entries = compact ? snapshot.compactEntries! : snapshot.entries;
    const entryCounts = compact ? snapshot.compactEntryTokens! : snapshot.entryTokens;
    const header = compact ? compactCatalogHeader : catalogHeader;
    const format = compact ? 'compact' : 'full';
    if (offset > entries.length) throw new SkillStoreError('INVALID_ARGUMENT', 'offset is beyond the catalog', { offset, total: entries.length });
    if (options.maxTokens === undefined) {
      const text = !compact && offset === 0 ? snapshot.text : header + entries.slice(offset).join('');
      const tokenCount = !compact && offset === 0 ? (snapshot.tokenCount ??= tokenize(text)) : tokenize(text);
      return { text, total: entries.length, returned: entries.length - offset, offset, nextOffset: null,
        complete: offset === 0, catalogHash: snapshot.hash, tokenCount, format };
    }
    let text = header;
    let returned = 0;
    let tokenCount = tokenize(text);
    const budget = options.maxTokens;
    if (tokenCount > budget) throw new SkillStoreError('CATALOG_HEADER_TOO_LARGE', 'Token budget cannot fit catalog header', { requiredTokens: tokenCount });
    // Independent entry counts find an initial page in linear time. Always check the
    // complete final string because BPE token boundaries can change at concatenation.
    let estimatedTokens = tokenCount;
    for (let i = offset; i < entries.length; i++) {
      const entryTokens = entryCounts[i] ??= tokenize(entries[i]);
      if (estimatedTokens + entryTokens > budget) break;
      estimatedTokens += entryTokens;
      returned++;
    }
    text += entries.slice(offset, offset + returned).join('');
    tokenCount = tokenize(text);
    while (tokenCount > budget && returned > 0) {
      returned--;
      text = header + entries.slice(offset, offset + returned).join('');
      tokenCount = tokenize(text);
    }
    while (offset + returned < entries.length) {
      const candidate = text + entries[offset + returned];
      const candidateTokens = tokenize(candidate);
      if (candidateTokens > budget) {
        if (returned === 0) throw new SkillStoreError('ENTRY_TOO_LARGE', 'A complete entry exceeds this page token budget; no metadata was truncated', { id: snapshot.ids[offset], offset, requiredTokens: candidateTokens, maxTokens: budget });
        break;
      }
      text = candidate; tokenCount = candidateTokens; returned++;
    }
    const nextOffset = offset + returned < entries.length ? offset + returned : null;
    return { text, total: entries.length, returned, offset, nextOffset, complete: offset === 0 && nextOffset === null, catalogHash: snapshot.hash, tokenCount, format };
  }

  getStats(): { files: number; skills: number; references: number; assets: number; blobs: number; bytes: number; uniqueBytes: number; repositories: string[]; errors: number } {
    const row = this.db.prepare(`SELECT COUNT(*) files, COALESCE(SUM(kind='skill'),0) skills, COALESCE(SUM(kind='reference'),0) refs,
      COALESCE(SUM(kind='asset'),0) assets, COALESCE(SUM(b.size),0) bytes, COALESCE(SUM(errors_json != '[]'),0) errors FROM files f JOIN blobs b ON f.hash=b.hash`).get() as DbRow;
    const blobs = this.db.prepare('SELECT COUNT(*) blobs, COALESCE(SUM(size),0) bytes FROM blobs').get() as DbRow;
    const repositories = this.db.prepare('SELECT DISTINCT repository FROM files ORDER BY repository').all() as DbRow[];
    return { files: Number(row.files), skills: Number(row.skills), references: Number(row.refs), assets: Number(row.assets), blobs: Number(blobs.blobs),
      bytes: Number(row.bytes), uniqueBytes: Number(blobs.bytes), repositories: repositories.map((r) => String(r.repository)), errors: Number(row.errors) };
  }

  close(): void { this.db.close(); }
}
