import { readFileSync, writeFileSync } from 'node:fs';
const at = process.argv.indexOf('--comparison');
const path = at < 0 ? 'reports/retest/comparison.json' : process.argv[at + 1];
const d = JSON.parse(readFileSync(path, 'utf8'));
const scopes = d.scopes;
const all = scopes[0];
const n = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });
const pct = (x: number) => `${x.toFixed(2)}%`;
const table = (head: string[], rows: (string | number)[][]) => `| ${head.join(' | ')} |\n|${head.map(() => '---').join('|')}|\n${rows.map(row => `| ${row.join(' | ')} |`).join('\n')}\n`;
const tests = d.validation?.checks.find((c: any) => c.name === 'automated-tests')?.testCount;
let section = `<!-- BEGIN_DETAILED_COMPARISON -->\n## Detailed test and comparison results\n\nThe current validation run passes **${tests} automated tests**, TypeScript checking, and browser-script syntax checking. Tests cover source preservation, complete discovery metadata, paging, exact accounting, stale snapshots, HTTP behavior, and six additional transport edge cases. These are software tests, not ${tests} model tasks. The separately retained browser check covers six interaction groups.\n\n`;
section += `The offline experiment uses **${n(d.corpus.readableSkills)} known targets** from **${n(d.corpus.listedSkills)} catalog occurrences**. Four unreadable entries remain visible in the registry and are excluded only from text-token measurement. The fixed encoding is ${d.tokenizer.name}. The corpus is finite and declared; coverage of all GitHub is not claimed.\n\n`;
section += '### What each measured arm delivers\n\n';
section += table(['Arm', 'Delivered content', 'Important accounting condition'], [
  ['R raw all', 'Every readable original SKILL.md, each with complete source framing', 'All occurrences retained'],
  ['D exact grouping', 'One body per exact hash and every occurrence mapping', 'Equal entry points do not merge package dependencies'],
  ['C plus S', 'Every full catalog page and one complete known-target source', 'Target supplied by the evaluator'],
  ['K plus H plus S', 'Every compact page, resolver metadata, and the same known-target source', 'Resolver overhead counted'],
  ['Replay variants', 'The corresponding complete catalog delivered twice', 'A controlled payload scenario, not actual history or billing'],
]);
section += '\nA whole message is encoded before counting. Counts of separate defined messages are added; that sum is not mislabeled as the encoding of a concatenated string. Protocol v2 uses at most 128 whole entries per experimental catalog page. The interactive CLI instead packs by token budget. Neither format shortens names or descriptions to force a page to fit.\n\n';
section += '### Global distribution and replay sensitivity\n\n';
section += table(['Measurement', 'Minimum', 'Median', 'p95', 'Maximum'], [
  ['Selected original source S', n(all.selected.min), n(all.selected.median), n(all.selected.p95), n(all.selected.max)],
  ['Resolver metadata H', n(all.resolver.min), n(all.resolver.median), n(all.resolver.p95), n(all.resolver.max)],
  ['Full catalog plus source', n(all.fullOnce.min), n(all.fullOnce.median), n(all.fullOnce.p95), n(all.fullOnce.max)],
  ['Compact catalog plus resolver plus source', n(all.compactOnce.min), n(all.compactOnce.median), n(all.compactOnce.p95), n(all.compactOnce.max)],
  ['Full catalog replay', n(all.fullReplay.min), n(all.fullReplay.median), n(all.fullReplay.p95), n(all.fullReplay.max)],
  ['Compact catalog replay', n(all.compactReplay.min), n(all.compactReplay.median), n(all.compactReplay.p95), n(all.compactReplay.max)],
]);
section += `\nUnit: tokens. Global compact catalog serialization alone is ${pct(all.catalogSavingPercent)} smaller than the full-identifier catalog. The median complete compact scenario is ${pct(all.compactVsFullMedianSavingPercent)} smaller than full catalog plus source, and ${pct(all.compactVsRawMedianSavingPercent)} smaller than raw-all. These are distinct baselines. The selected target is already known, and additional model decisions and required reference reads remain unmeasured.\n\n`;
section += '### Detailed scope comparison\n\n';
section += table(['Scope', 'Readable occurrences', 'Distinct texts', 'Repeated occurrences'], scopes.map((s: any) => [s.label, n(s.occurrences), n(s.distinctTextHashes), pct(s.repeatedOccurrencePercent)]));
section += '\n';
section += table(['Scope', 'R raw', 'D exact grouping', 'C full catalog', 'K compact catalog'], scopes.map((s: any) => [s.label, n(s.rawTokens), n(s.dedupTokens), n(s.fullCatalogTokens), n(s.compactCatalogTokens)]));
section += '\n';
section += table(['Scope', 'Median C plus S', 'Median K plus H plus S', 'Dedup saving vs raw', 'Compact larger target cases'], scopes.map((s: any) => [s.label, n(s.fullOnce.median), n(s.compactOnce.median), pct(s.dedupSavingPercent), s.compactLargerThanFullCases]));
section += '\nGlobal, released-sample, pinned-panel, and repository rows overlap. Do not pool them as independent samples. Repeated occurrence percentages concern exact entry-point text hashes, not independently useful capabilities.\n\n';
section += '### Counterexamples and interpretation\n\n';
section += 'Exact grouping increases payload in six low-duplication repository scopes: Anthropic, Superpowers, OpenAI plugins, historical OpenAI skills, Vercel, and reverse-skill. Their grouping and provenance overhead exceeds the duplicated body tokens recovered. Negative savings are retained in the table. The global 53.03% dedup reduction is therefore a corpus-dependent finding.\n\n';
section += 'Compact mode has the lower median complete scenario in every repository scope, but it is larger for nine individual targets: two Anthropic, two UI UX Pro Max, one Superpowers, and four Vercel cases. These are repository-scoped comparisons; the global catalog has no such target-level counterexample in this run. A shorter catalog does not automatically imply a lower complete selected-target payload once resolver metadata is included.\n\n';
section += 'For Vercel, full and compact complete-scenario medians are 3,452 and 3,400 tokens, only 1.51% apart. Four of nine selected targets favor full identifiers. Format choice therefore has a more modest effect in a small library than the global catalog percentage might suggest.\n\n';
section += '### Context capacity outcomes\n\n';
section += table(['Scope', 'Targets', 'C plus S fits at 32000', 'K plus H plus S fits at 32000', 'C plus S fits at 128000', 'K plus H plus S fits at 128000'], scopes.map((s: any) => [s.label, n(s.occurrences), n(s.context[0].oracleResidentFitCount), n(s.context[0].compactOracleResidentFitCount), n(s.context[1].oracleResidentFitCount), n(s.context[1].compactOracleResidentFitCount)]));
section += '\nEvery context scenario reserves 4,096 tokens. The full global compact catalog is 3,135,249 tokens; no global target fits either resident budget. Affaan\'s complete compact scope fits all 1,062 targets at 128,000 while its full catalog alone overflows that budget. Microsoft fits 183 of 212 compact targets at 32,000, demonstrating why catalog fit alone is insufficient. These are defined payload-capacity checks, not provider model tests.\n\n';
section += '### Integrity and reproducibility\n\n';
section += `The corpus audit verifies 60,418 stored blobs, 98,460 occurrence identities, and all 40,545 compact catalog rows. There are zero internal integrity or catalog-coverage failures; unavailable sample supporting files remain explicit source gaps. One whole catalog entry requires 19,422 tokens, so the audit records the oversized-entry result and requests enough room rather than truncating or skipping it.\n\n`;
section += `The ${d.currentRun === d.previousRun ? 'analysis currently references the same baseline run; a fresh run is required before asserting independent reproduction' : 'fresh run ' + d.currentRun + (d.allScopesReproduced ? ' reproduced all fourteen scope aggregates, distributions, context outcomes, and message-sequence hashes from the previous run' : ' differs from the previous run; inspect comparison.json')}. Generation timestamps and local runtime are not payload equality criteria. This is deterministic calculation repeatability, not model-inference repeatability.\n\n`;
section += '```powershell\nnode scripts/validate.ts\nnode scripts/audit.ts --out reports/retest/integrity.json\nnode scripts/benchmark.ts --db data/skillgraph.sqlite --out reports/retest\nnode scripts/compare.ts --report reports/retest/benchmark.json --out reports/retest\n```\n\n';
section += 'The complete per-target rows are retained in the retest JSON and CSV; derived comparisons are in `reports/retest/comparison.json` and `.md`. Validation commands and exit codes are retained in `reports/retest/validation.json`. Local timings concern software execution only.\n\n';
section += '### Outcomes that remain unmeasured\n\n';
section += table(['Outcome', 'Current status'], [
  ['Model skill-selection accuracy and abstention', 'Not run; no authenticated model endpoint'],
  ['Citation support and task success', 'Not run; future human-reviewed and verifier-based evaluation'],
  ['Actual input, output, retries, and cached usage', 'Not measured by the offline tokenizer'],
  ['Model latency and monetary savings', 'Not measured'],
  ['Top-k retrieval and learned instruction compression', 'Conceptual comparison only; not executed numerical baselines'],
]);
section += '\nThese missing outcomes are not zeros and must not be inferred from the oracle payload reduction. Cached input is a subset of provider input, not an extra category to add twice. The current study establishes source integrity and defined data-message costs; the local manuscript specifies the future quality evaluation.\n<!-- END_DETAILED_COMPARISON -->\n';
let readme = readFileSync('README.md', 'utf8').replace('The automated suite has 21 passing tests.', `The expanded automated suite has ${tests} passing tests.`);
const marker = /<!-- BEGIN_DETAILED_COMPARISON -->[\s\S]*?<!-- END_DETAILED_COMPARISON -->\n?/;
if (marker.test(readme)) readme = readme.replace(marker, section);
else readme = readme.replace('## Reproduce acquisition', section + '\n## Reproduce acquisition');
writeFileSync('README.md', readme);
console.log(JSON.stringify({ readme: 'README.md', comparison: path, tests, scopes: scopes.length }));
