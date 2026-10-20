import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { tokenize } from '../src/core.ts';
import { queryEvidence, type EvidenceQuery } from '../src/evidence.ts';

const args = process.argv.slice(2);
const inputs: string[] = [], oracles: string[] = [];
let destination = resolve('reports/evidence-study');
for (let i = 0; i < args.length; i += 2) {
  if (!args[i + 1]) throw new Error(`Missing ${args[i]} value`);
  if (args[i] === '--input') inputs.push(resolve(args[i + 1]));
  else if (args[i] === '--oracle') oracles.push(resolve(args[i + 1]));
  else if (args[i] === '--out') destination = resolve(args[i + 1]);
  else throw new Error(`Unknown option ${args[i]}`);
}
assert.ok(inputs.length > 0 && inputs.length === oracles.length, 'Provide one --oracle per --input');
mkdirSync(destination, { recursive: true });
const run = resolve(destination, 'run-' + randomUUID()); mkdirSync(run);
const instrumentation = resolve(run, 'process-metrics.mjs');
writeFileSync(instrumentation, `process.on('exit',()=>{const u=process.resourceUsage();process.stderr.write('PROCESS_METRICS '+JSON.stringify({cpuMs:(u.userCPUTime+u.systemCPUTime)/1000,peakRssKiB:u.maxRSS})+'\\n')});`);
const tokenCache = new Map<string, number>();
function count(text: string) { const key = createHash('sha256').update(text).digest('hex'); let n = tokenCache.get(key); if (n === undefined) { n = tokenize(text); tokenCache.set(key, n); } return n; }
function execute(argv: string[]) {
  const start = performance.now();
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(instrumentation).href, ...argv], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32_000_000 });
  const wallMs = performance.now() - start;
  assert.equal(result.status, 0, result.stderr);
  const metrics = JSON.parse(result.stderr.split(/\r?\n/).find(line => line.startsWith('PROCESS_METRICS '))!.slice('PROCESS_METRICS '.length));
  return { text: result.stdout, wallMs, ...metrics };
}
const queries: EvidenceQuery[] = [ { view: 'summary' }, { view: 'extensions' },
  ...['.gd', '.dll', '.py', '.tscn', '.absent'].map(extension => ({ view: 'files' as const, extension, limit: 100 })),
  { view: 'files', limit: 500 } ];
const cases: any[] = [];
for (let caseIndex = 0; caseIndex < inputs.length; caseIndex++) {
  const input = inputs[caseIndex], oracleBytes = readFileSync(oracles[caseIndex]);
  const independentOracle = JSON.parse(oracleBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const oracle = { ...independentOracle, ...independentOracle.rawHeader };
  const raw = execute(['-e', "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))", input]);
  const rawTokens = count(raw.text);
  let checkedRecords = 0;
  const coldCache = resolve(run, `case-${caseIndex}-cold`);
  const coldTimings: number[] = [], warmTimings: number[] = [];
  for (const query of queries) {
    let started = performance.now(); const cold = queryEvidence(input, query, coldCache); coldTimings.push(performance.now() - started); assert.equal(cold.cacheHit, false);
    started = performance.now(); const warm = queryEvidence(input, query, coldCache); warmTimings.push(performance.now() - started); assert.equal(warm.cacheHit, true);
    assert.ok(isDeepStrictEqual({ ...cold, cacheHit: undefined }, { ...warm, cacheHit: undefined }), 'Cached payload differs from fresh computation');
  }
  const modes: any[] = [];
  for (const mode of ['focused-no-cache', 'focused-cache-hit']) {
    const responses: any[] = [], answers: any[] = [];
    for (const originalQuery of queries) {
      const items: any[] = []; let offset = 0; let first: any;
      do {
        const query = originalQuery.view === 'files' ? { ...originalQuery, offset } : originalQuery;
        const argv = ['src/cli.ts', 'evidence', '--input', input, '--view', query.view];
        if (query.view === 'files') { argv.push('--offset', String(offset), '--limit', String(query.limit)); if (query.extension) argv.push('--extension', query.extension); }
        if (mode === 'focused-cache-hit') {
          queryEvidence(input, query, coldCache); // Warm this exact page outside timed CLI execution.
          argv.push('--cache', coldCache);
        }
        const execution = execute(argv), reply = JSON.parse(execution.text); first ??= reply;
        assert.equal(reply.cacheHit, mode === 'focused-cache-hit');
        responses.push({ query, responseTokens: count(execution.text), wallMs: execution.wallMs, cpuMs: execution.cpuMs, peakRssKiB: execution.peakRssKiB });
        if (query.view !== 'files') break;
        items.push(...reply.answer.items);
        if (reply.answer.nextOffset === null) break;
        assert.equal(reply.answer.nextOffset, offset + reply.answer.items.length); offset = reply.answer.nextOffset;
      } while (true);
      if (originalQuery.view === 'summary') {
        assert.equal(first.pathWarnings.backslashTerminatedFileEntries, oracle.files.filter((file: any) => file.path.endsWith('\\')).length);
        assert.equal(first.answer.rootSha256, oracle.archiveSha256);
        assert.equal(first.answer.files, oracle.files.length); assert.equal(first.answer.directories, oracle.directories);
        assert.equal(first.answer.declaredFileBytes, oracle.fileBytes); checkedRecords += 4;
      } else if (originalQuery.view === 'extensions') { assert.deepEqual(first.answer, oracle.extensions); checkedRecords += oracle.extensions.length; }
      else {
        const expected = oracle.files.filter((file: any) => !originalQuery.extension || file.path.toLowerCase().endsWith(originalQuery.extension));
        assert.equal(first.answer.total, expected.length);
        assert.ok(isDeepStrictEqual(items.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), expected), 'Selected file records differ from independent ZIP oracle');
        checkedRecords += items.length;
      }
      answers.push(originalQuery.view === 'files' ? items : first.answer);
    }
    modes.push({ mode, requests: responses.length, tokens: responses.reduce((sum, r) => sum + r.responseTokens, 0),
      totalWallMs: responses.reduce((sum, r) => sum + r.wallMs, 0), totalCpuMs: responses.reduce((sum, r) => sum + r.cpuMs, 0),
      peakRssKiB: Math.max(...responses.map(r => r.peakRssKiB)), responses, answers });
  }
  assert.deepEqual(modes[0].answers, modes[1].answers);
  cases.push({ case: caseIndex + 1, inputSha256: createHash('sha256').update(readFileSync(input)).digest('hex'),
    pathInterpretationDisagreement: independentOracle.pathInterpretationDisagreement,
    rawHeaderFiles: oracle.files.length, pythonPlatformFiles: independentOracle.files.length,
    rawHeaderDirectories: oracle.directories, pythonPlatformDirectories: independentOracle.directories,
    oracleSha256: createHash('sha256').update(oracleBytes).digest('hex'), queries: queries.length, checkedRecords,
    rawReportOnce: { tokens: rawTokens, wallMs: raw.wallMs, cpuMs: raw.cpuMs, peakRssKiB: raw.peakRssKiB },
    producerColdViewMs: coldTimings, producerWarmViewMs: warmTimings,
    modes: modes.map(({ answers, ...rest }) => rest), verified: true });
  console.log(JSON.stringify({ completedCase: caseIndex + 1, rawTokens, focusedTokens: modes[0].tokens, verified: true }));
}
const rawTokens = cases.reduce((sum, item) => sum + item.rawReportOnce.tokens, 0);
const focusedTokens = cases.reduce((sum, item) => sum + item.modes[0].tokens, 0);
const report = { generatedAt: new Date().toISOString(), runtime: process.version, platform: process.platform,
  protocol: 'evidence-projection-pilot-v1', encoding: 'o200k_base', cases,
  totals: { cases: cases.length, queriesPerMode: cases.length * queries.length, checkedRecords: cases.reduce((s, c) => s + c.checkedRecords, 0), rawTokens, focusedTokens, reductionPercent: (1 - focusedTokens / rawTokens) * 100 },
  limitations: [ 'Token counts cover stdout data responses, not model input/output usage, commands, schemas or reasoning.',
    'Raw comparison delivers each full report only once, not once per question.',
    'Projections answer declared inventory questions; they do not preserve all raw fields inline. Full source remains retained and hash-addressed.',
    'Deterministic oracle agreement is not AI semantic accuracy or task-success equivalence for untested questions.',
    'No-cache focused views are a strong baseline. Memoization is not expected to reduce their response tokens.',
    'CLI timings include process startup; raw delivery and multi-query projection perform different amounts of host computation.',
    'Warm producer timing includes input hashing and retained-source verification. It is measured once per query, not a statistical speed guarantee.',
    'Peak RSS is per measured Node process, not a process-family memory measurement.',
    'Only supplied ZIP artifacts are covered; selection bias and small sample size limit generalization.' ] };
writeFileSync(resolve(destination, 'measurement.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.totals, null, 2));
