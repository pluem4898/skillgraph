# Measured evidence-output optimization

Measured locally on October 20, 2026 (Asia/Bangkok), with Node.js 24.11.0,
Python 3.12.14 and the pinned REA 6.7.0 CLI. Machine-readable counts,
per-request timings, source/oracle digests, validation log hashes and code
digests are in [evidence-results.json](evidence-results.json).

## Result and scope

| Input | Full recorded REA output, delivered once | All requested focused responses | Reduction |
|---|---:|---:|---:|
| Real embedded ZIP 1 | 601,708 | 99,731 | 83.43% |
| Real embedded ZIP 2 | 45,561 | 11,693 | 74.34% |
| Real inputs combined | 647,269 | 111,424 | **82.79%** |
| Authored public demo, separately measured | 136,401 | 31,267 | **77.08%** |

These are separately encoded **stdout data-response tokens using o200k_base**.
They are not provider input/output usage, paid cost, total model tokens or a
claim about all tasks. Commands, tool schemas, skill instructions, reasoning,
model output and retries are excluded. The raw comparator sends each report
only once; it is not artificially repeated for every question.

This improves the evidence-delivery stage, not the skill catalog itself.
All skills, names and descriptions remain available through complete catalog
enumeration. Focused evidence responses do not carry every raw analysis field
inline. They carry the fields needed for explicit questions, original coverage
and limitations, path warnings, source hashes and stable occurrence indices.
The entire JSON source is retained under its SHA-256; `record --index` recovers
the original occurrence and artifact fields. This is explicit projection with
retained evidence, not reversible text compression of the whole raw response.

## What was actually tested

The two real ZIPs were previously carved from a user-supplied executable. REA
was run again on both ZIPs to create fresh artifact inventories. The executable
was not run, and no successful game installation or native decompilation is
claimed. The real inputs contain 1,341 and 100 raw-header file entries. The
user's executable, ZIPs, source evidence and extracted content are not published.

For each ZIP, eight query groups were executed through real CLI subprocesses:

1. Summary: archive SHA-256, file/directory counts and total declared file bytes.
2. Complete extension-count table.
3. Complete `.gd` file records.
4. Complete `.dll` file records.
5. Complete `.py` file records.
6. Complete `.tscn` file records.
7. A nonexistent extension, verifying a genuine empty result.
8. Every file, including all pages, paths, sizes and full SHA-256 values.

There are **16 query groups per mode** across the real inputs. Queries were
executed without memoization and again with cache hits. Every requested file
record was compared to an independent Python stdlib ZIP reader which read and
CRC-checked member bytes and computed SHA-256 itself. Aggregate accounting
contains 3,144 record/field comparisons across the two modes, including repeated
records; this is not 3,144 independent tasks or an AI accuracy sample.

The public demo separately contains 304 authored files and one explicit directory,
including Unicode paths, duplicate content and an empty file. It is synthetic
and is not pooled with the real-input result.

## Quality findings, including the disagreement

All declared raw-header inventory queries matched the independent raw-header
oracle after the representation issues below were addressed. Cache-hit answers
matched fresh computations. The 36-test software suite also covers source/query
invalidation, damaged caches, malformed inputs, unknown records, whole-record
paging, source limitations and exact source recovery.

One real ZIP uses literal Windows backslashes in every member name, including
one zero-byte entry ending in a backslash. REA preserves the literal names and
reports 100 files / 0 directories. Python's Windows-normalized interpretation
reports 99 files / 1 directory. **The system preserves and warns about this
disagreement; it does not claim that the two interpretations agree.** The oracle
retains both raw header names and Python-interpreted counts. This distinction was
added after the first oracle comparison failed; it was not preregistered. Users
asking about actual extracted directories must resolve extractor semantics.

An early cache comparison also exposed an optional-property representation
difference: an absent extension became `undefined` before JSON persistence.
Normalization now omits absent fields consistently, and regression tests cover
cold/warm result equality. These failures were found and corrected during
development; final results are not claims of first-attempt success.

**No independent model-quality A/B experiment was run.** Exact deterministic
answers on these inventory questions do not establish unchanged AI reasoning,
semantic accuracy or task success on other questions. A summary cannot answer
an omitted-field question; use an original record or full retained evidence.

## Runtime, CPU and memory

| Real-input mode | Total CLI wall time | Total process CPU time | Peak process RSS |
|---|---:|---:|---:|
| Full raw reports, one delivery each | 0.191 s | 0.139 s | 55.23 MiB |
| Focused views, no memoization | 3.083 s | 3.047 s | 73.45 MiB |
| Same focused views, cache hits | 3.009 s | 3.045 s | 69.06 MiB |

Raw delivery only copies JSON; focused mode validates and answers many queries
in 18 processes. These are different host computations, so the table does not
establish an end-to-end speed comparison. **Less output did not mean less host
work or universally lower memory.** The measured cache-hit CLI wall time is only
2.40% lower than no-cache focused views overall, and the smaller real case was
slightly slower with caching. Response tokens were identical with and without
memoization: the token saving comes from projections, not a fictitious token
discount for cached host results.

In-process producer measurements, excluding subprocess startup, were 159.90 ms
for first cached computations versus 67.65 ms for immediate cache hits across
the real query groups. These are single paired local observations, not a
statistical speed guarantee. Input hashing and retained-source verification
remain included. RSS is measured per Node process, not across a process family.
Native module loading was deferred and the tokenizer initialized lazily to
avoid paying for unrelated skill parsing/tokenization in evidence-only commands.

## Try it without private data

After a fresh checkout, install Node.js 24+ dependencies with
`npm ci --ignore-scripts`. Python 3 is used only for the independent oracle and
authored demo creation. Then run:

```powershell
python scripts/make-evidence-demo.py --out reports/demo.zip
npx --yes rea-agents@6.7.0 inspect-artifact reports/demo.zip --format json > reports/demo-rea.json
python scripts/zip-oracle.py --archive reports/demo.zip --out reports/demo-oracle.json
node scripts/evidence-study.ts --input reports/demo-rea.json --oracle reports/demo-oracle.json --out reports/demo-study
node scripts/validate.ts
```

The optional `npx` command downloads the pinned REA package. It requires network
access, no paid model endpoint, no native disassembler and no execution of ZIP
members. Use a shell that writes redirected output as UTF-8, such as PowerShell
7 or a POSIX shell. Counts can vary with producer output, paths, platform and
dependency versions; compare your generated `measurement.json` and digests.

Inspect an individual view with:

```powershell
node src/cli.ts evidence --input reports/demo-rea.json --view summary --cache data/evidence
node src/cli.ts evidence --input reports/demo-rea.json --view files --extension .gd --limit 100 --cache data/evidence
node src/cli.ts evidence --input reports/demo-rea.json --view record --index 42 --cache data/evidence
```

Source snapshots, derived results and full local measurements remain under
ignored `data/` and `reports/` directories. Small aggregate measurements, code
and the demo generator are public. Exact reproduction of the real-input totals
requires those private input bytes; the public demo reproduces the method,
not the private dataset. The manuscript remains local and unpublished.
