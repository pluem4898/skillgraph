import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SkillStore, tokenize } from '../src/core.ts';

/** This measures serialized delivery payloads, not AI skill selection or API bills. */
export const PROTOCOL = 'skillgraph-offline-payload-v2';
export const CATALOG_PAGE_ENTRIES = 128;
export const CONTEXT_LIMITS = [32_000, 128_000] as const;
export const RESERVED_TOKENS = 4_096;

export interface Source {
  id: string;
  repository: string;
  commit: string;
  path: string;
  hash: string;
  totalLines: number;
  text: string;
  /** Exact serialized metadata returned by the store's handle resolver. */
  metadataJson?: string;
}

export type CountTokens = (text: string) => number;
export type ContextStatus = { contextTokens: number; reservedTokens: number; payloadBudget: number; status: 'FITS_PAYLOAD_BUDGET' | 'CONTEXT_OVERFLOW'; excessTokens: number };
export type Distribution = { count: number; min: number | null; median: number | null; p95: number | null; max: number | null; mean: number | null; sum: number };

export function frame(body: string): string {
  // Raw bodies are NOT escaped, normalized, truncated, summarized, or executed.
  return `PROTOCOL ${PROTOCOL}\nBEGIN_DATA\n${body}\nEND_DATA\n`;
}

export function sourceFrame(source: Source): string {
  return `SOURCE ${JSON.stringify({ id: source.id, repository: source.repository, commit: source.commit, path: source.path, hash: source.hash, startLine: 1, endLine: source.totalLines, utf8Bytes: Buffer.byteLength(source.text, 'utf8') })}\n${source.text}\nEND_SOURCE\n`;
}

export function rawPayload(sources: readonly Source[]): string {
  return frame(sources.map(sourceFrame).join(''));
}
export function* sourceMessages(sources: readonly Source[]): Generator<string> {
  for (const source of sources) yield rawPayload([source]);
}

export function* deduplicatedMessages(sources: readonly Source[]): Generator<string> {
  const groups = new Map<string, Source[]>();
  for (const source of sources) {
    const group = groups.get(source.hash);
    if (group && group[0].text !== source.text) throw new Error(`HASH_COLLISION_OR_CORRUPTION: ${source.hash}`);
    if (group) group.push(source);
    else groups.set(source.hash, [source]);
  }
  for (const [hash, occurrences] of groups) {
    // All provenance survives deduplication. References from copies can differ.
    const map = occurrences.map(({ id, repository, commit, path, totalLines }) => ({ id, repository, commit, path, startLine: 1, endLine: totalLines }));
    yield frame(`CONTENT ${JSON.stringify({ hash, utf8Bytes: Buffer.byteLength(occurrences[0].text, 'utf8'), occurrences: map })}\n${occurrences[0].text}\nEND_CONTENT\n`);
  }
}

/** Convenience only; production measurement streams separate messages. */
export function deduplicatedPayload(sources: readonly Source[]): { text: string; uniqueContents: number } {
  const messages = [...deduplicatedMessages(sources)];
  return { text: messages.join(''), uniqueContents: messages.length };
}

export function* catalogMessages(catalogText: string, compact = false): Generator<string> {
  const lines = catalogText.split('\n');
  let header = lines.shift() ?? '';
  if (lines.at(-1) === '') lines.pop();
  const catalogHash = createHash('sha256').update(catalogText).digest('hex');
  if (compact) {
    if (header !== JSON.stringify(['id', 'name', 'description', 'path', 'hash', 'errors'])) throw new Error('INVALID_COMPACT_CATALOG_SCHEMA');
    header = JSON.stringify(['handle', 'name', 'description', 'path', 'errors']);
    for (let i = 0; i < lines.length; i++) {
      const row = JSON.parse(lines[i]);
      lines[i] = JSON.stringify([`s${i + 1}`, row[1], row[2], row[3], row[5]]);
    }
  }
  for (let offset = 0; offset < Math.max(1, lines.length); offset += CATALOG_PAGE_ENTRIES) {
    const entries = lines.slice(offset, offset + CATALOG_PAGE_ENTRIES);
    yield frame(`CATALOG_PAGE ${JSON.stringify({ format: compact ? 'compact' : 'full', catalogHash, offset, returned: entries.length, total: lines.length })}\n${header}\n${entries.join('\n')}\n`);
  }
}

export function resolutionMessage(source: Source): string {
  const { text: _text, metadataJson, ...metadata } = source;
  return frame(`HANDLE_RESOLUTION\n${metadataJson ?? JSON.stringify(metadata)}\n`);
}

export function measureMessages(messages: Iterable<string>, countTokens: CountTokens) {
  const digest = createHash('sha256');
  let tokens = 0;
  let messageCount = 0;
  for (const message of messages) {
    // The length prefix makes the ordered sequence hash unambiguous.
    digest.update(`${Buffer.byteLength(message, 'utf8')}:`).update(message);
    tokens += countTokens(message);
    messageCount++;
  }
  return { tokens, messageCount, hash: digest.digest('hex') };
}

export function contextStatus(payloadTokens: number, contextTokens: number, reservedTokens = RESERVED_TOKENS): ContextStatus {
  const payloadBudget = Math.max(0, contextTokens - reservedTokens);
  return { contextTokens, reservedTokens, payloadBudget, status: payloadTokens <= payloadBudget ? 'FITS_PAYLOAD_BUDGET' : 'CONTEXT_OVERFLOW', excessTokens: Math.max(0, payloadTokens - payloadBudget) };
}

export function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count,
    min: count ? sorted[0] : null,
    median: count ? (count % 2 ? sorted[(count - 1) / 2] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2) : null,
    p95: count ? sorted[Math.ceil(count * 0.95) - 1] : null,
    max: count ? sorted[count - 1] : null,
    mean: count ? sum / count : null,
    sum,
  };
}

export function savingsPercent(baseline: number, candidate: number): number | null {
  return baseline === 0 ? null : (1 - candidate / baseline) * 100;
}

export function measureScope(scope: string, sources: readonly Source[], catalogText: string, countTokens: CountTokens) {
  // v2 defines source/content/catalog-page as DISTINCT complete data messages.
  // Counts are exact for those messages; NOT the token count of a concatenation.
  const raw = measureMessages(sourceMessages(sources), countTokens);
  const dedup = measureMessages(deduplicatedMessages(sources), countTokens);
  const catalog = measureMessages(catalogMessages(catalogText), countTokens);
  const compact = measureMessages(catalogMessages(catalogText, true), countTokens);
  const rawAllTokens = raw.tokens;
  const exactDedupTokens = dedup.tokens;
  const catalogTokens = catalog.tokens;
  const compactCatalogTokens = compact.tokens;
  const rows = sources.map((source) => {
    const selectedTokens = countTokens(rawPayload([source]));
    // Separate serialized data messages: C + S, or C + C + S in a replay scenario.
    // Provider role tokens, model output, selection, retries, and full history are NOT measured.
    const deliveredOnceTokens = catalogTokens + selectedTokens;
    const catalogReplayTokens = 2 * catalogTokens + selectedTokens;
    const resolutionTokens = countTokens(resolutionMessage(source));
    const compactDeliveredOnceTokens = compactCatalogTokens + resolutionTokens + selectedTokens;
    const compactCatalogReplayTokens = 2 * compactCatalogTokens + resolutionTokens + selectedTokens;
    return {
      scope, id: source.id, repository: source.repository, commit: source.commit, path: source.path, hash: source.hash,
      rawAllTokens, exactDedupTokens, catalogTokens, selectedTokens, deliveredOnceTokens, catalogReplayTokens,
      deliveredOnceSavingsPercent: savingsPercent(rawAllTokens, deliveredOnceTokens),
      catalogReplaySavingsPercent: savingsPercent(rawAllTokens, catalogReplayTokens),
      compactCatalogTokens, resolutionTokens, compactDeliveredOnceTokens, compactCatalogReplayTokens,
      compactDeliveredOnceSavingsPercent: savingsPercent(rawAllTokens, compactDeliveredOnceTokens),
      // C+S is a conservative resident-payload proxy; individual message fitting alone does not prove full-context fitting.
      residentPayloadBudget: CONTEXT_LIMITS.map((limit) => contextStatus(deliveredOnceTokens, limit)),
    };
  });
  return {
    scope,
    occurrences: sources.length,
    uniqueContents: dedup.messageCount,
    rawAllTokens,
    exactDedupTokens,
    exactDedupSavingsPercent: savingsPercent(rawAllTokens, exactDedupTokens),
    catalogTokens,
    compactCatalogTokens,
    compactCatalogSavingsPercent: savingsPercent(catalogTokens, compactCatalogTokens),
    rawMessageCount: raw.messageCount, dedupMessageCount: dedup.messageCount, catalogMessageCount: catalog.messageCount,
    rawPayloadHash: raw.hash, dedupPayloadHash: dedup.hash, catalogPayloadHash: catalog.hash,
    compactCatalogPayloadHash: compact.hash,
    selectedTokens: distribution(rows.map((row) => row.selectedTokens)),
    deliveredOnceTokens: distribution(rows.map((row) => row.deliveredOnceTokens)),
    catalogReplayTokens: distribution(rows.map((row) => row.catalogReplayTokens)),
    resolutionTokens: distribution(rows.map((row) => row.resolutionTokens)),
    compactDeliveredOnceTokens: distribution(rows.map((row) => row.compactDeliveredOnceTokens)),
    compactCatalogReplayTokens: distribution(rows.map((row) => row.compactCatalogReplayTokens)),
    compactDeliveredOnceSavingsPercent: distribution(rows.flatMap((row) => row.compactDeliveredOnceSavingsPercent === null ? [] : [row.compactDeliveredOnceSavingsPercent])),
    deliveredOnceSavingsPercent: distribution(rows.flatMap((row) => row.deliveredOnceSavingsPercent === null ? [] : [row.deliveredOnceSavingsPercent])),
    catalogReplaySavingsPercent: distribution(rows.flatMap((row) => row.catalogReplaySavingsPercent === null ? [] : [row.catalogReplaySavingsPercent])),
    context: CONTEXT_LIMITS.map((limit) => ({
      ...contextStatus(rawAllTokens, limit),
      exactDedup: contextStatus(exactDedupTokens, limit),
      catalog: contextStatus(catalogTokens, limit),
      compactCatalog: contextStatus(compactCatalogTokens, limit),
      compactOracleResidentFitCount: rows.filter((row) => contextStatus(row.compactDeliveredOnceTokens, limit).status === 'FITS_PAYLOAD_BUDGET').length,
      oracleResidentFitCount: rows.filter((row) => contextStatus(row.deliveredOnceTokens, limit).status === 'FITS_PAYLOAD_BUDGET').length,
      oracleResidentOverflowCount: rows.filter((row) => contextStatus(row.deliveredOnceTokens, limit).status === 'CONTEXT_OVERFLOW').length,
    })),
    rows,
  };
}

type ScopeResult = ReturnType<typeof measureScope>;
type Store = InstanceType<typeof SkillStore>;

type CatalogEntry = { id: string; repository: string; commit: string; line: string };
function collectSources(store: Store): { sources: Source[]; catalogEntries: CatalogEntry[]; excluded: { id: string; reason: string }[]; listed: number } {
  const sources: Source[] = [];
  const catalogEntries: CatalogEntry[] = [];
  const excluded: { id: string; reason: string }[] = [];
  let offset = 0;
  let expected: number | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = store.listSkills({ offset, limit: 1000 });
    expected ??= page.total;
    if (page.total !== expected) throw new Error('SNAPSHOT_CHANGED: skill count changed during enumeration');
    for (const item of page.items) {
      if (seen.has(item.id)) throw new Error(`DUPLICATE_ENUMERATION: ${item.id}`);
      seen.add(item.id);
      catalogEntries.push({ id: item.id, repository: item.repository, commit: item.commit,
        line: JSON.stringify([item.id, item.name, item.description, item.path, item.hash, item.errors]) + '\n' });
      const file = store.getFile(item.id);
      if (!file || typeof file.text !== 'string') {
        excluded.push({ id: item.id, reason: 'SOURCE_NOT_READABLE_AS_TEXT' });
        continue;
      }
      const { text: _text, ...metadata } = file;
      sources.push({ id: file.id, repository: file.repository, commit: file.commit, path: file.path, hash: file.hash, totalLines: file.totalLines, text: file.text, metadataJson: JSON.stringify(metadata) });
    }
    if (page.nextOffset === null || page.nextOffset === undefined) break;
    if (page.nextOffset <= offset) throw new Error('INVALID_CURSOR: enumeration made no progress');
    offset = page.nextOffset;
  }
  if (seen.size !== expected) throw new Error(`INCOMPLETE_ENUMERATION: ${seen.size}/${expected}`);
  return { sources, catalogEntries, excluded, listed: seen.size };
}

function completeCatalog(entries: readonly CatalogEntry[]): string {
  // Same unabridged catalog columns as the store, without asking it to encode a giant string.
  return JSON.stringify(['id', 'name', 'description', 'path', 'hash', 'errors']) + '\n' + entries.map((entry) => entry.line).join('');
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export function renderCsv(scopes: readonly ScopeResult[]): string {
  const columns = ['scope', 'id', 'repository', 'commit', 'path', 'hash', 'rawAllTokens', 'exactDedupTokens', 'catalogTokens', 'selectedTokens', 'deliveredOnceTokens', 'catalogReplayTokens', 'deliveredOnceSavingsPercent', 'catalogReplaySavingsPercent', 'compactCatalogTokens', 'resolutionTokens', 'compactDeliveredOnceTokens', 'compactCatalogReplayTokens', 'compactDeliveredOnceSavingsPercent'] as const;
  return `${columns.join(',')}\n${scopes.flatMap((scope) => scope.rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))).join('\n')}\n`;
}

function format(value: number | null): string {
  return value === null ? 'N/A' : Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(2);
}

export function renderMarkdown(report: ReturnType<typeof runBenchmark>): string {
  const table = report.scopes.map((scope) => `| ${scope.scope} | ${format(scope.occurrences)} | ${format(scope.uniqueContents)} | ${format(scope.rawAllTokens)} | ${format(scope.exactDedupTokens)} | ${format(scope.catalogTokens)} | ${format(scope.compactCatalogTokens)} | ${format(scope.deliveredOnceTokens.median)} | ${format(scope.compactDeliveredOnceTokens.median)} |`).join('\n');
  const contextTable = report.scopes.flatMap((scope) => scope.context.map((result) => `| ${scope.scope} | ${format(result.contextTokens)} | ${result.status} | ${result.exactDedup.status} | ${result.catalog.status} | ${result.compactCatalog.status} | ${result.compactOracleResidentFitCount}/${scope.occurrences} |`)).join('\n');
  return `# Offline oracle payload benchmark

Generated: ${report.generatedAt}

**Measured:** every readable imported SKILL.md is supplied as a known selected target. No AI selected a skill, no imported skill was executed, and no paid API was called. This is not retrieval accuracy, semantic preservation or end-to-end cost.

Corpus: ${format(report.corpus.listedSkills)} listed occurrences; ${format(report.corpus.readableSkills)} readable oracle targets; ${report.corpus.excluded.length} unreadable targets explicitly excluded. The corpus combines pinned GitHub repositories and the released GitSkills sample where present; it is **not all GitHub**. Dataset snapshot identifiers are not upstream repository commits. Supporting files remain in the store but are outside every arm of this SKILL.md-only comparison; their necessity is not evaluated.

Tokenizer: ${report.tokenizer.name}, js-tiktoken ${report.tokenizer.packageVersion}. Protocol v2 counts each complete serialized message exactly and sums the messages: one per raw source, one per distinct content with provenance mappings, and catalog pages of at most 128 complete entries. These are NOT concatenated-string counts; do not compare directly to v1. All protocol/page framing and catalog snapshot hashes are included. Provider role framing is not measured. A hash-keyed memo avoids re-encoding identical messages without discounting their delivery count.

| Scope | Occurrences | Unique texts | R: raw messages | D: dedup | C: full catalog | K: compact catalog | Median C+S | Median K+H+S |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${table}

R preserves every original occurrence; D stores one body per exact hash and every occurrence mapping, without merging packages. C preserves all names, full descriptions, paths, IDs, source hashes and errors. K preserves every entry and all names, full descriptions, paths and errors while replacing repeated ID/hash strings with snapshot-bound handles. K requires a resolve operation. H is the complete framed resolver metadata response, counted for every selected target; S is the complete framed selected source. K is an alternate transport with a lookup requirement, not semantic compression. The uncompact catalog remains available.

C+S and K+H+S are one-delivery scenarios. 2C+S and 2K+H+S replay the catalogs once; JSON/CSV include these values. They do not include actual tool requests, model output/reasoning, provider role framing, all history replays, retries, cache hits or billing. Savings are relative to R; negative savings are retained. Oracle savings cannot establish real model efficiency because the target is already known.

## Context scenarios

Capacities below reserve ${RESERVED_TOKENS} tokens for instructions/query/output, a scenario assumption rather than a provider guarantee. Catalog-plus-source is a resident-payload proxy. Pagination does not make all pages simultaneously visible in one model context; overflow is preserved rather than silently removing skills.

| Scope | Context | R | D | C | K | K+H+S fitting targets |
|---|---:|---|---|---|---|---:|
${contextTable}

## Reproduction and limitations

Run \`node scripts/benchmark.ts --db data/skillgraph.sqlite --out reports\` after the importer finishes. Every readable occurrence is a target in ALL; corpus and repository subscopes overlap and must not be pooled as independent observations. JSON stores all rows/distributions and ordered payload-sequence hashes; CSV gives one row per target and scope. Sequence hashes use a decimal UTF-8 byte-length prefix and colon before each message, preserving order and boundaries. Unchanged input should produce identical hashes/counts; generation timestamps can differ.

This benchmark does not establish optimality, accuracy, noninferiority, semantic equivalence, actual API cost or latency. The full corpus includes copied and malformed examples and is not a random GitHub sample. Dataset supporting-file coverage can be partial; see importer reports. Cached input is a subset of input and must not be added a second time. See ../research/paper-en.md and ../research/protocol.md for interpretation and the future human-labeled paired experiment.
`;
}

export function runBenchmark(dbPath: string) {
  const store = new SkillStore(dbPath);
  try {
    const { sources, catalogEntries, excluded, listed } = collectSources(store);
    if (!listed) throw new Error('EMPTY_CORPUS: import at least one repository before benchmarking');
    const sorted = sources.sort((a, b) => `${a.repository}\0${a.commit}\0${a.path}`.localeCompare(`${b.repository}\0${b.commit}\0${b.path}`, 'en'));
    const tokenCache = new Map<string, number>();
    const count: CountTokens = (text) => {
      const key = createHash('sha256').update(text).digest('hex');
      let value = tokenCache.get(key);
      if (value === undefined) { value = tokenize(text); tokenCache.set(key, value); }
      return value;
    };
    const dataset = (commit: string) => commit.startsWith('dataset:');
    const plans: { scope: string; sources: Source[]; entries: CatalogEntry[] }[] = [
      { scope: 'ALL', sources: sorted, entries: catalogEntries },
    ];
    const pinned = sorted.filter((source) => !dataset(source.commit));
    const sampled = sorted.filter((source) => dataset(source.commit));
    if (sampled.length) plans.push({ scope: 'GITSKILLS_SAMPLE', sources: sampled, entries: catalogEntries.filter((entry) => dataset(entry.commit)) });
    if (pinned.length) plans.push({ scope: 'GITHUB_PINNED', sources: pinned, entries: catalogEntries.filter((entry) => !dataset(entry.commit)) });
    for (const repository of [...new Set(pinned.map((source) => source.repository))].sort()) {
      plans.push({ scope: repository, sources: pinned.filter((source) => source.repository === repository), entries: catalogEntries.filter((entry) => !dataset(entry.commit) && entry.repository === repository) });
    }
    const scopes = plans.map((plan) => {
      process.stderr.write(`Measuring ${plan.scope}: ${plan.sources.length} targets\n`);
      return measureScope(plan.scope, plan.sources, completeCatalog(plan.entries), count);
    });
    let packageVersion = 'unknown';
    try { packageVersion = (JSON.parse(readFileSync(new URL('../node_modules/js-tiktoken/package.json', import.meta.url), 'utf8')) as { version: string }).version; } catch { /* explicit unknown for alternate package layout */ }
    return {
      schemaVersion: 2,
      protocol: PROTOCOL,
      generatedAt: new Date().toISOString(),
      measurement: 'OFFLINE_ORACLE_DELIVERY_PAYLOAD_NOT_AI_RETRIEVAL',
      tokenizer: { name: 'o200k_base', package: 'js-tiktoken', packageVersion },
      corpus: { database: resolve(dbPath), listedSkills: listed, readableSkills: sources.length, excluded, storeStats: store.getStats() },
      assumptions: {
        targetSelection: 'Known target, once per readable imported skill occurrence; no model selection performed.',
        supportingFiles: 'Excluded from ALL methods in this benchmark; accessible in the store and not assumed semantically unnecessary.',
        framing: 'v2: one complete message per raw source; one per exact-content group with occurrence mappings; catalog pages of at most 128 entries, repeating column header. Sum exact per-message encodings. Not concatenated-string counts and not comparable directly with v1.',
        sequenceHash: 'SHA-256 of ordered length-prefixed UTF-8 messages; length is decimal byte count followed by colon.',
        catalogPageEntries: CATALOG_PAGE_ENTRIES,
        replay: 'One-fetch C+S and a second catalog delivery 2C+S; not full model history cost.',
        contextReservedTokens: RESERVED_TOKENS,
        cachedTokens: 'Not measured. Cached input is a subset of total input, never added twice.',
        unmeasured: ['AI retrieval accuracy', 'task success', 'semantic equivalence', 'model output/reasoning', 'provider role tokens', 'tool-selection requests', 'retries', 'API latency', 'paid API cost'],
      },
      scopes,
    };
  } finally { store.close(); }
}

function main(args: string[]) {
  let db = 'data/skillgraph.sqlite';
  let out = 'reports';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--db' && args[index + 1]) db = args[++index];
    else if (args[index] === '--out' && args[index + 1]) out = args[++index];
    else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
  const report = runBenchmark(db);
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
  const { repositories: _repositories, ...summaryStats } = report.corpus.storeStats;
  const dashboardSummary = {
    ...report,
    corpus: { ...report.corpus, storeStats: summaryStats },
    scopes: report.scopes.map(({ rows: _rows, ...scope }) => scope),
  };
  writeFileSync(resolve(out, 'benchmark-summary.json'), `${JSON.stringify(dashboardSummary, null, 2)}\n`);
  writeFileSync(resolve(out, 'benchmark.csv'), renderCsv(report.scopes));
  writeFileSync(resolve(out, 'benchmark.md'), renderMarkdown(report));
  const global = report.scopes[0];
  process.stdout.write(`${JSON.stringify({ report: resolve(out, 'benchmark.json'), readableSkills: report.corpus.readableSkills, rawAllTokens: global.rawAllTokens, catalogTokens: global.catalogTokens, medianOraclePayloadSavingsPercent: global.deliveredOnceSavingsPercent.median })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
