# SkillGraph

A CLI-first skill registry for complete discovery, original source reads, and reproducible token measurement. The optional web viewer is a separate inspection tool; the skill requires no web server.

## Use the skill

Open this directory as your Codex project. The project-local skill is [.agents/skills/skillgraph/SKILL.md](.agents/skills/skillgraph/SKILL.md). Invoke `$skillgraph` in that project, or give an agent the skill file explicitly. It is not installed into your global skills directory.

The skill exposes every imported occurrence in the declared scope, retains full names and descriptions, and lets the agent choose which original instructions to read. It never substitutes a hidden relevance-filtered top-k list. Short handles are bound to the catalog digest and resolved before source access.

Requires Node.js 24 or newer. The repository contains source code and acquisition settings; it does not bundle downloaded skills, databases, generated reports, or the manuscript.

### Start from a fresh checkout

```powershell
git clone https://github.com/pluem4898/skillgraph.git
cd skillgraph
npm ci --ignore-scripts
node scripts/validate.ts
node scripts/import-github.ts --repos anthropics/skills --ref dbd4588f9e1033efb41dad4bef2f7947c8993d44
node scripts/smoke-cli.ts --repository anthropics/skills
```

The single-repository import is a small, explicitly declared example scope. It requires network access and is subject to GitHub API rate limits. To acquire the full measured panel instead, follow “Reproduce acquisition” below. Imported files are stored in a local SQLite database under `data/`; no third-party skill scripts are executed. An empty checkout has no skill inventory until an import is run.

```powershell
node src/cli.ts stats
node src/cli.ts catalog --offset 0 --maxTokens 8000
node src/cli.ts catalog --offset NEXT --maxTokens 8000 --catalogHash DIGEST
node src/cli.ts resolve --handle s1 --catalogHash DIGEST
node src/cli.ts read --file FILE_ID --start 1 --end TOTAL_LINES --hash CONTENT_HASH
```

Follow every `nextOffset` before final selection. Preserve the same explicit repository scope and catalog digest across pages and resolution. The final page does not itself establish that earlier pages were reviewed. If the full catalog exceeds available context, report that limit rather than silently narrowing the scope. An explicit user-selected repository can be supplied with `--repository owner/repo`.

Additional operations:

```powershell
node src/cli.ts inspect --file FILE_ID
node src/cli.ts files --repository OWNER/REPO --package PACKAGE_PATH
node src/cli.ts catalog --format full --maxTokens 8000
node src/cli.ts read --file FILE_ID --start 10 --end 50 --hash CONTENT_HASH --numbered
```

Original source bytes, line endings, and line coordinates are preserved. Binary or malformed skills remain listed with diagnostics. Metadata resolution and exact body reads are separate, reducing repeated discovery identifiers. Downloaded skills are inspected as data; importing does not install them or run their scripts.

## Lower-overhead source access

Prefer a raw text wire and a combined resolve/read when selecting an original skill:

```powershell
node src/cli.ts catalog --repository OWNER/REPO --wire text --maxTokens 8000
node src/cli.ts open --repository OWNER/REPO --handle s1 --catalogHash DIGEST --wire text
node src/cli.ts open --repository OWNER/REPO --handle s1 --catalogHash DIGEST --reference examples/guide.md --wire text
```

Catalog text wire returns a JSON page receipt followed by unescaped JSONL entries. Source text wire returns a JSON provenance receipt followed by exact original bytes, including original line endings. Verify `utf8Bytes` before treating a source response as complete. `open` defaults to the whole selected file; optional `--start` and `--end` address original line ranges. Known references stay within the selected package and commit. Old JSON commands remain supported; `resolve` is useful when headings and resolved links are actually needed.

On the three-task local pilot, rerunning real CLI access while preserving identical source and reference text produced:

| Task | Earlier SkillGraph | Optimized SkillGraph | Direct-file index baseline |
|---|---:|---:|---:|
| Brand CSS | 3,675 | 3,080 | 2,971 |
| Weekly update with reference | 5,605 | 3,729 | 3,586 |
| Form repair | 3,981 | 3,450 | 3,365 |
| Total | 13,261 | 10,259 | 9,922 |

These are separately encoded skill-data response tokens using o200k_base, not total model usage. The optimized total is 22.64% smaller than the earlier SkillGraph path and still 3.40% above the direct-file baseline. The output artifacts passed 34 final acceptance checks per arm in the preceding single-agent pilot. This optimization replay verified exact guide/reference equality and does not constitute independent model A/B evaluation or a new task-quality experiment. Current software validation passes 29 tests, including commit-pinned direct reference reads and exact text-wire CLI bytes.

## Measured corpus

The locally measured corpus contains 40,545 skill occurrences from 11,848 repository names, combining eleven commit-pinned GitHub repositories with a bounded GitSkills sample. It is not bundled with this repository and is not all GitHub. There are 40,541 readable token-study targets, 98,460 total file occurrences, and 60,418 distinct stored blobs.

Every sample artifact occurrence was imported and hash-verified. Supporting-file coverage is incomplete: 16,768 sample sibling rows have no supplied content and three supplied sibling texts could not be repaired from their advertised blob endpoints. Unsupported symlinks in pinned repositories remain explicit exclusions. Details are retained in `data/import.json`, `data/gitskills-import.json`, and dataset provenance tables. Dataset revision identifiers are distinct from upstream repository commits.

## Verification and results

### Pre-publication checks

The release was checked from a separate clean checkout on Node.js 24.11.0 / Windows:

- `npm ci --ignore-scripts`: successful; npm reported zero known vulnerabilities across the installed dependency tree at check time.
- `node scripts/validate.ts`: 27 tests passed; TypeScript and browser-script syntax checks passed.
- The quick-start command downloaded the pinned Anthropic repository and verified its Git tree: 20 skill occurrences and 445 total files; no failed or partial repository acquisition.
- `node scripts/smoke-cli.ts --repository anthropics/skills`: 10 real CLI subprocess calls passed, covering complete compact/full catalog equivalence, resolution, inspection, whole-source SHA-256, the original final line, package inventory, and stale-snapshot rejection.
- The separate full local corpus audit verified 60,418 blobs and all 40,545 catalog occurrences with zero internal failures; declared external source gaps remain.

These checks exercise real source acquisition and local tool use. They do not call an AI model. CI is configured for Node.js 24 on Windows and Linux; local Windows checks do not establish that a remote Linux run has passed.

```powershell
node --test tests/*.test.ts
node node_modules/typescript/bin/tsc --noEmit
node scripts/audit.ts
node scripts/benchmark.ts --db data/skillgraph.sqlite --out reports
```

The expanded automated suite has 27 passing tests. The corpus audit verifies all 60,418 stored blobs and all 40,545 catalog occurrences, with zero integrity or catalog-coverage failures and explicit source gaps retained. Full audit evidence is in `reports/integrity.json`.

Offline protocol v2 uses the fixed o200k_base encoding and exact complete data-message counts:

| Global scenario | Tokens |
|---|---:|
| Every source skill, framed separately | 86,051,633 |
| Exact-content groups with every occurrence mapping | 40,418,213 |
| Complete full-identifier catalog | 6,034,240 |
| Complete compact catalog | 3,135,249 |
| Median compact catalog + resolver + known target | 3,137,582 |

Compact serialization reduces catalog payload by 48.04%, retaining every discovery field defined by the protocol. The known-target scenario is 96.35% smaller than raw-all, but it supplies the target in advance. It is not a measured improvement in AI retrieval, end-to-end model usage, or billed cost. The full compact catalog still exceeds the tested 32,000- and 128,000-token context scenarios. Pagination does not remove that resident-context limit.

`reports/benchmark.json` and `reports/benchmark.csv` retain all target rows. The smaller `reports/benchmark-summary.json` supplies aggregate results to the optional viewer. Supporting files are excluded from every arm of this SKILL.md-only experiment; tasks that need them will incur additional reads.

<!-- BEGIN_DETAILED_COMPARISON -->
## Detailed test and comparison results

The current validation run passes **27 automated tests**, TypeScript checking, and browser-script syntax checking. Tests cover source preservation, complete discovery metadata, paging, exact accounting, stale snapshots, HTTP behavior, and six additional transport edge cases. These are software tests, not 27 model tasks. The separately retained browser check covers six interaction groups.

The offline experiment uses **40,541 known targets** from **40,545 catalog occurrences**. Four unreadable entries remain visible in the registry and are excluded only from text-token measurement. The fixed encoding is o200k_base. The corpus is finite and declared; coverage of all GitHub is not claimed.

### What each measured arm delivers

| Arm | Delivered content | Important accounting condition |
|---|---|---|
| R raw all | Every readable original SKILL.md, each with complete source framing | All occurrences retained |
| D exact grouping | One body per exact hash and every occurrence mapping | Equal entry points do not merge package dependencies |
| C plus S | Every full catalog page and one complete known-target source | Target supplied by the evaluator |
| K plus H plus S | Every compact page, resolver metadata, and the same known-target source | Resolver overhead counted |
| Replay variants | The corresponding complete catalog delivered twice | A controlled payload scenario, not actual history or billing |

A whole message is encoded before counting. Counts of separate defined messages are added; that sum is not mislabeled as the encoding of a concatenated string. Protocol v2 uses at most 128 whole entries per experimental catalog page. The interactive CLI instead packs by token budget. Neither format shortens names or descriptions to force a page to fit.

### Global distribution and replay sensitivity

| Measurement | Minimum | Median | p95 | Maximum |
|---|---|---|---|---|
| Selected original source S | 176 | 1,705 | 5,225 | 59,979 |
| Resolver metadata H | 202 | 579 | 1,262 | 44,756 |
| Full catalog plus source | 6,034,416 | 6,035,945 | 6,039,465 | 6,094,219 |
| Compact catalog plus resolver plus source | 3,135,635 | 3,137,582 | 3,141,607 | 3,239,984 |
| Full catalog replay | 12,068,656 | 12,070,185 | 12,073,705 | 12,128,459 |
| Compact catalog replay | 6,270,884 | 6,272,831 | 6,276,856 | 6,375,233 |

Unit: tokens. Global compact catalog serialization alone is 48.04% smaller than the full-identifier catalog. The median complete compact scenario is 48.02% smaller than full catalog plus source, and 96.35% smaller than raw-all. These are distinct baselines. The selected target is already known, and additional model decisions and required reference reads remain unmeasured.

### Detailed scope comparison

| Scope | Readable occurrences | Distinct texts | Repeated occurrences |
|---|---|---|---|
| All sources | 40,541 | 18,220 | 55.06% |
| Released sample | 29,785 | 12,999 | 56.36% |
| Pinned panel | 10,756 | 5,240 | 51.28% |
| affaan-m/everything-claude-code | 1,062 | 926 | 12.81% |
| alirezarezvani/claude-skills | 388 | 376 | 3.09% |
| anthropics/skills | 20 | 20 | 0.00% |
| microsoft/skills | 212 | 211 | 0.47% |
| nextlevelbuilder/ui-ux-pro-max-skill | 13 | 7 | 46.15% |
| obra/superpowers | 15 | 15 | 0.00% |
| openai/plugins | 536 | 536 | 0.00% |
| openai/skills | 44 | 44 | 0.00% |
| sickn33/antigravity-awesome-skills | 8,368 | 3,012 | 64.01% |
| vercel-labs/agent-skills | 9 | 9 | 0.00% |
| zhaoxuya520/reverse-skill | 89 | 89 | 0.00% |

| Scope | R raw | D exact grouping | C full catalog | K compact catalog |
|---|---|---|---|---|
| All sources | 86,051,633 | 40,418,213 | 6,034,240 | 3,135,249 |
| Released sample | 62,336,555 | 28,226,138 | 4,543,941 | 2,414,247 |
| Pinned panel | 23,715,078 | 12,232,130 | 1,489,307 | 719,009 |
| affaan-m/everything-claude-code | 2,587,942 | 2,246,572 | 161,436 | 84,350 |
| alirezarezvani/claude-skills | 897,522 | 865,007 | 75,063 | 46,855 |
| anthropics/skills | 71,451 | 71,551 | 3,926 | 2,467 |
| microsoft/skills | 494,571 | 490,591 | 38,814 | 23,447 |
| nextlevelbuilder/ui-ux-pro-max-skill | 27,816 | 16,526 | 2,263 | 1,335 |
| obra/superpowers | 40,236 | 40,311 | 1,935 | 843 |
| openai/plugins | 1,182,667 | 1,185,347 | 82,942 | 44,045 |
| openai/skills | 105,447 | 105,667 | 7,087 | 3,908 |
| sickn33/antigravity-awesome-skills | 18,147,604 | 7,057,849 | 1,098,745 | 499,484 |
| vercel-labs/agent-skills | 18,334 | 18,379 | 1,521 | 870 |
| zhaoxuya520/reverse-skill | 141,488 | 141,933 | 16,822 | 10,313 |

| Scope | Median C plus S | Median K plus H plus S | Dedup saving vs raw | Compact larger target cases |
|---|---|---|---|---|
| All sources | 6,035,945 | 3,137,582 | 53.03% | 0 |
| Released sample | 4,545,551 | 2,416,439 | 54.72% | 0 |
| Pinned panel | 1,491,255.5 | 721,654 | 48.42% | 0 |
| affaan-m/everything-claude-code | 163,500.5 | 87,065 | 13.19% | 0 |
| alirezarezvani/claude-skills | 77,330.5 | 49,896.5 | 3.62% | 0 |
| anthropics/skills | 6,049 | 5,332.5 | -0.14% | 2 |
| microsoft/skills | 41,008 | 26,498.5 | 0.80% | 0 |
| nextlevelbuilder/ui-ux-pro-max-skill | 4,256 | 4,028 | 40.59% | 2 |
| obra/superpowers | 4,028 | 3,478 | -0.19% | 1 |
| openai/plugins | 84,648.5 | 46,313.5 | -0.23% | 0 |
| openai/skills | 8,905 | 6,345.5 | -0.21% | 0 |
| sickn33/antigravity-awesome-skills | 1,100,680 | 502,109.5 | 61.11% | 0 |
| vercel-labs/agent-skills | 3,452 | 3,400 | -0.25% | 4 |
| zhaoxuya520/reverse-skill | 17,678 | 11,673 | -0.31% | 0 |

Global, released-sample, pinned-panel, and repository rows overlap. Do not pool them as independent samples. Repeated occurrence percentages concern exact entry-point text hashes, not independently useful capabilities.

### Counterexamples and interpretation

Exact grouping increases payload in six low-duplication repository scopes: Anthropic, Superpowers, OpenAI plugins, historical OpenAI skills, Vercel, and reverse-skill. Their grouping and provenance overhead exceeds the duplicated body tokens recovered. Negative savings are retained in the table. The global 53.03% dedup reduction is therefore a corpus-dependent finding.

Compact mode has the lower median complete scenario in every repository scope, but it is larger for nine individual targets: two Anthropic, two UI UX Pro Max, one Superpowers, and four Vercel cases. These are repository-scoped comparisons; the global catalog has no such target-level counterexample in this run. A shorter catalog does not automatically imply a lower complete selected-target payload once resolver metadata is included.

For Vercel, full and compact complete-scenario medians are 3,452 and 3,400 tokens, only 1.51% apart. Four of nine selected targets favor full identifiers. Format choice therefore has a more modest effect in a small library than the global catalog percentage might suggest.

### Context capacity outcomes

| Scope | Targets | C plus S fits at 32000 | K plus H plus S fits at 32000 | C plus S fits at 128000 | K plus H plus S fits at 128000 |
|---|---|---|---|---|---|
| All sources | 40,541 | 0 | 0 | 0 | 0 |
| Released sample | 29,785 | 0 | 0 | 0 | 0 |
| Pinned panel | 10,756 | 0 | 0 | 0 | 0 |
| affaan-m/everything-claude-code | 1,062 | 0 | 0 | 0 | 1,062 |
| alirezarezvani/claude-skills | 388 | 0 | 0 | 388 | 388 |
| anthropics/skills | 20 | 19 | 19 | 20 | 20 |
| microsoft/skills | 212 | 0 | 183 | 212 | 212 |
| nextlevelbuilder/ui-ux-pro-max-skill | 13 | 13 | 13 | 13 | 13 |
| obra/superpowers | 15 | 15 | 15 | 15 | 15 |
| openai/plugins | 536 | 0 | 0 | 536 | 536 |
| openai/skills | 44 | 44 | 44 | 44 | 44 |
| sickn33/antigravity-awesome-skills | 8,368 | 0 | 0 | 0 | 0 |
| vercel-labs/agent-skills | 9 | 9 | 9 | 9 | 9 |
| zhaoxuya520/reverse-skill | 89 | 89 | 89 | 89 | 89 |

Every context scenario reserves 4,096 tokens. The full global compact catalog is 3,135,249 tokens; no global target fits either resident budget. Affaan's complete compact scope fits all 1,062 targets at 128,000 while its full catalog alone overflows that budget. Microsoft fits 183 of 212 compact targets at 32,000, demonstrating why catalog fit alone is insufficient. These are defined payload-capacity checks, not provider model tests.

### Integrity and reproducibility

The corpus audit verifies 60,418 stored blobs, 98,460 occurrence identities, and all 40,545 compact catalog rows. There are zero internal integrity or catalog-coverage failures; unavailable sample supporting files remain explicit source gaps. One whole catalog entry requires 19,422 tokens, so the audit records the oversized-entry result and requests enough room rather than truncating or skipping it.

The fresh run 2026-10-19T22:20:19.349Z reproduced all fourteen scope aggregates, distributions, context outcomes, and message-sequence hashes from the previous run. Generation timestamps and local runtime are not payload equality criteria. This is deterministic calculation repeatability, not model-inference repeatability.

```powershell
node scripts/validate.ts
node scripts/audit.ts --out reports/retest/integrity.json
node scripts/benchmark.ts --db data/skillgraph.sqlite --out reports/retest
node scripts/compare.ts --report reports/retest/benchmark.json --out reports/retest
```

The complete per-target rows are retained in the retest JSON and CSV; derived comparisons are in `reports/retest/comparison.json` and `.md`. Validation commands and exit codes are retained in `reports/retest/validation.json`. Local timings concern software execution only.

### Outcomes that remain unmeasured

| Outcome | Current status |
|---|---|
| Model skill-selection accuracy and abstention | Not run; no authenticated model endpoint |
| Citation support and task success | Not run; future human-reviewed and verifier-based evaluation |
| Actual input, output, retries, and cached usage | Not measured by the offline tokenizer |
| Model latency and monetary savings | Not measured |
| Top-k retrieval and learned instruction compression | Conceptual comparison only; not executed numerical baselines |

These missing outcomes are not zeros and must not be inferred from the oracle payload reduction. Cached input is a subset of provider input, not an extra category to add twice. The current study establishes source integrity and defined data-message costs; the local manuscript specifies the future quality evaluation.
<!-- END_DETAILED_COMPARISON -->

## Reproduce acquisition

```powershell
node scripts/import-github.ts --config config/corpus.lock.json
node scripts/import-gitskills.ts --download
```

The lock file records the measured repository commits. `config/corpus.json` is the separate discovery configuration for updating the panel; its HEAD references may produce a different snapshot. The sample importer pins its archive revision and digest. All source gaps, failed acquisitions, and repairs are reported. New snapshots may coexist, so use a fresh database for a new independent experiment.

The full GitSkills release was not downloaded. This run uses its bounded public sample plus the declared pinned panel. Third-party licenses and source provenance remain attached to their original packages. Public availability does not imply a uniform redistribution license. Downloaded corpus content is excluded from ordinary Git tracking.

## Optional research viewer

```powershell
node src/server.ts
```

Open `http://127.0.0.1:4318`. The viewer provides complete paginated inventory, original line reads, snapshot evidence, resolved Markdown links, diagnostics, and actual experiment summaries. It does not call a model or execute imported scripts. Its interface is English; original corpus text is displayed verbatim in its source language.

For headless browser checks, start the server and run `node scripts/ui-smoke.mjs`. The supplied script uses the installed Microsoft Edge browser; set `EDGE_PATH` for another compatible installation. Screenshots and the check record are generated under `reports/`.

## Local manuscript

The English five-chapter manuscript and prospective evaluation protocol remain local under `research/`. That entire directory is excluded by `.gitignore` and is not included in this repository.

The manuscript reports completed structural and offline experiments. Live model selection, task success, actual usage, latency, and monetary savings remain unmeasured. No API key or authenticated standalone Codex CLI was available for those experiments. Never substitute the offline oracle numbers for those pending results.

## Project layout

- `.agents/skills/skillgraph/`: the actual project-local skill.
- `src/`: source store, parser, catalog transport, CLI, and optional viewer server.
- `scripts/`: acquisition, token benchmark, corpus audit, and browser checks.
- `config/`: discovery settings and exact measured repository lock.
- `tests/`: meaningful integrity, transport, and HTTP behavior checks.
- `data/`, `reports/`, `research/`: local corpus, generated evidence, and manuscript; ignored by Git.
