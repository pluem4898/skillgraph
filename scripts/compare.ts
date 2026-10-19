import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const argument = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1] || fallback; };
const currentPath = resolve(argument('--report', 'reports/retest/benchmark.json'));
const previousPath = resolve(argument('--previous', 'reports/benchmark-summary.json'));
const destination = resolve(argument('--out', 'reports/retest'));
mkdirSync(destination, { recursive: true });
const report = JSON.parse(readFileSync(currentPath, 'utf8'));
const previous = JSON.parse(readFileSync(previousPath, 'utf8'));
const validation = existsSync(resolve(destination, 'validation.json')) ? JSON.parse(readFileSync(resolve(destination, 'validation.json'), 'utf8')) : null;
const n = (value: number | null) => value === null ? 'N/A' : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const percentage = (value: number) => `${value.toFixed(2)}%`;
const median = (values: number[]) => { const s = values.sort((a, b) => a - b); return s.length ? s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 : null; };
const scopeNames: Record<string, string> = { ALL: 'All sources', GITHUB_PINNED: 'Pinned panel', GITSKILLS_SAMPLE: 'Released sample' };
const scopes = report.scopes.map((scope: any) => {
  const rows = scope.rows;
  const strictReplayLimits = rows.map((row: any) => Math.max(0, Math.ceil((row.rawAllTokens - row.resolutionTokens - row.selectedTokens) / row.compactCatalogTokens) - 1));
  const prior = previous.scopes.find((candidate: any) => candidate.scope === scope.scope);
  const keys = ['occurrences', 'uniqueContents', 'rawAllTokens', 'exactDedupTokens', 'catalogTokens', 'compactCatalogTokens', 'rawPayloadHash', 'dedupPayloadHash', 'catalogPayloadHash', 'compactCatalogPayloadHash'];
  const mismatches = keys.filter(key => !prior || prior[key] !== scope[key]);
  for (const key of ['selectedTokens', 'deliveredOnceTokens', 'catalogReplayTokens', 'resolutionTokens', 'compactDeliveredOnceTokens', 'compactCatalogReplayTokens', 'context']) {
    if (!prior || JSON.stringify(prior[key]) !== JSON.stringify(scope[key])) mismatches.push(key);
  }
  return {
    scope: scope.scope, label: scopeNames[scope.scope] || scope.scope,
    occurrences: scope.occurrences, distinctTextHashes: scope.uniqueContents,
    repeatedOccurrencePercent: (1 - scope.uniqueContents / scope.occurrences) * 100,
    rawTokens: scope.rawAllTokens, dedupTokens: scope.exactDedupTokens,
    dedupSavingPercent: scope.exactDedupSavingsPercent,
    fullCatalogTokens: scope.catalogTokens, compactCatalogTokens: scope.compactCatalogTokens,
    catalogSavingPercent: scope.compactCatalogSavingsPercent,
    selected: scope.selectedTokens, resolver: scope.resolutionTokens,
    fullOnce: scope.deliveredOnceTokens, compactOnce: scope.compactDeliveredOnceTokens,
    fullReplay: scope.catalogReplayTokens, compactReplay: scope.compactCatalogReplayTokens,
    compactVsFullMedianSavingPercent: (1 - scope.compactDeliveredOnceTokens.median / scope.deliveredOnceTokens.median) * 100,
    fullVsRawMedianSavingPercent: (1 - scope.deliveredOnceTokens.median / scope.rawAllTokens) * 100,
    compactVsRawMedianSavingPercent: (1 - scope.compactDeliveredOnceTokens.median / scope.rawAllTokens) * 100,
    compactSmallerThanFullCases: rows.filter((r: any) => r.compactDeliveredOnceTokens < r.deliveredOnceTokens).length,
    compactLargerThanFullCases: rows.filter((r: any) => r.compactDeliveredOnceTokens > r.deliveredOnceTokens).length,
    compactSmallerThanRawCases: rows.filter((r: any) => r.compactDeliveredOnceTokens < r.rawAllTokens).length,
    maximumCompleteCatalogCopiesWithStrictPayloadSaving: { minimum: Math.min(...strictReplayLimits), median: median(strictReplayLimits), maximum: Math.max(...strictReplayLimits) },
    context: scope.context,
    reproducibility: { matchesPrior: mismatches.length === 0, mismatches },
  };
});
const global = scopes[0];
const derived = {
  generatedAt: new Date().toISOString(), reportPath: currentPath, previousPath,
  classification: 'Derived deterministic comparisons of offline oracle payloads; not live AI inference or billing.',
  currentRun: report.generatedAt, previousRun: previous.generatedAt,
  corpus: report.corpus, tokenizer: report.tokenizer,
  validation,
  allScopesReproduced: scopes.every((scope: any) => scope.reproducibility.matchesPrior),
  databaseFileBytes: statSync(report.corpus.database).size,
  scopes,
};
writeFileSync(resolve(destination, 'comparison.json'), JSON.stringify(derived, null, 2));
const table = (headers: string[], rows: (string | number)[][]) => `| ${headers.join(' | ')} |\n|${headers.map(() => '---').join('|')}|\n${rows.map(row => `| ${row.join(' | ')} |`).join('\n')}\n`;
let md = `# Detailed measured comparison\n\nRetest generated: ${report.generatedAt}. Encoding: ${report.tokenizer.name}. Classification: offline oracle data payload.\n\n`;
md += `All ${scopes.length} scope aggregates and message-sequence hashes ${derived.allScopesReproduced ? 'matched' : 'did not match'} the previous run. This checks deterministic payload reproducibility, not inference repeatability. Software validation: ${validation?.checks.find((check: any) => check.name === 'automated-tests')?.testCount || 'unavailable'} tests; ${validation?.status || 'unavailable'}.\n\n`;
md += '## Corpus composition\n\n';
md += table(['Scope', 'Readable occurrences', 'Distinct texts', 'Repeated occurrences'], scopes.map((s: any) => [s.label, n(s.occurrences), n(s.distinctTextHashes), percentage(s.repeatedOccurrencePercent)]));
md += '\nOccurrences and distinct texts are different units. Equal entry-point bytes do not establish equal package dependencies. The global, panel, sample, and repository scopes overlap.\n\n## Source and catalog payloads\n\n';
md += table(['Scope', 'R raw', 'D dedup', 'C full catalog', 'K compact catalog', 'D saving vs R', 'K saving vs C'], scopes.map((s: any) => [s.label, n(s.rawTokens), n(s.dedupTokens), n(s.fullCatalogTokens), n(s.compactCatalogTokens), percentage(s.dedupSavingPercent), percentage(s.catalogSavingPercent)]));
md += '\nNegative dedup savings are retained: exact grouping has provenance overhead and can increase tokens in a corpus with little duplication.\n\n## Known target and replay comparisons\n\n';
md += table(['Scope', 'Median C plus S', 'Median K plus H plus S', 'Median full replay', 'Median compact replay', 'Compact vs full saving'], scopes.map((s: any) => [s.label, n(s.fullOnce.median), n(s.compactOnce.median), n(s.fullReplay.median), n(s.compactReplay.median), percentage(s.compactVsFullMedianSavingPercent)]));
md += '\nC is the full catalog, K the compact catalog, H the selected handle resolver response, and S the selected original body. Replay sends the complete catalog a second time; other messages remain once. Negative compact-vs-full values mean that resolver overhead outweighed the catalog reduction. These scenarios have known targets and exclude model requests and output.\n\n## Distribution of source and resolver payloads\n\n';
md += table(['Scope', 'Source median', 'Source p95', 'Source maximum', 'Resolver median', 'Resolver p95', 'Compact scenario p95'], scopes.map((s: any) => [s.label, n(s.selected.median), n(s.selected.p95), n(s.selected.max), n(s.resolver.median), n(s.resolver.p95), n(s.compactOnce.p95)]));
md += '\nPercentiles use the nearest-rank p95. A sum of component medians is not assumed to equal the median of their sum.\n\n## Case level transport comparison\n\n';
md += table(['Scope', 'KHS below CS', 'KHS above CS', 'KHS below R', 'Total targets', 'Median maximum catalog copies below R'], scopes.map((s: any) => [s.label, n(s.compactSmallerThanFullCases), n(s.compactLargerThanFullCases), n(s.compactSmallerThanRawCases), n(s.occurrences), n(s.maximumCompleteCatalogCopiesWithStrictPayloadSaving.median)]));
md += '\nThe last column is an algebraic sensitivity scenario: the largest integer number of complete compact-catalog deliveries for which m times K plus H plus S remains strictly below R. It is not a measured number of model turns or a feasible resident-context recommendation.\n\n## Resident context outcomes\n\n';
md += table(['Scope', 'Context', 'Raw fits', 'Full catalog fits', 'Compact catalog fits', 'CS fitting targets', 'KHS fitting targets'], scopes.flatMap((s: any) => s.context.map((c: any) => [s.label, n(c.contextTokens), c.status === 'FITS_PAYLOAD_BUDGET' ? 'yes' : 'no', c.catalog.status === 'FITS_PAYLOAD_BUDGET' ? 'yes' : 'no', c.compactCatalog.status === 'FITS_PAYLOAD_BUDGET' ? 'yes' : 'no', `${n(c.oracleResidentFitCount)}/${n(s.occurrences)}`, `${n(c.compactOracleResidentFitCount)}/${n(s.occurrences)}`])));
md += `\nEvery scenario reserves 4,096 tokens. The global compact catalog requires ${n(global.compactCatalogTokens)} tokens and is infeasible in both tested contexts. Pagination changes delivery boundaries, not resident capacity.\n\n## Unmeasured outcomes\n\nAI retrieval accuracy, task success, citation support, actual input and output usage, cache hits, model latency, and monetary savings were not measured. No authenticated model endpoint was available. Top-k retrieval, symbolic instruction compression, and learned prompt compression were not executed as numerical baselines.\n`;
writeFileSync(resolve(destination, 'comparison.md'), md);
console.log(JSON.stringify({ comparison: resolve(destination, 'comparison.json'), scopes: scopes.length, reproduced: derived.allScopesReproduced, compactWorseScopes: scopes.filter((s: any) => s.compactVsFullMedianSavingPercent < 0).map((s: any) => s.scope) }));
