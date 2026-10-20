# Actual model usage pilot

Measured on October 20, 2026 using saved ChatGPT authentication and Codex CLI
0.162.0-alpha.17.2. Requested model: `gpt-6-astra`, reasoning effort `ultra`.
The events did not report a resolved backend model identifier.

This is one authored synthetic inventory task, repeated twice per arm. It is an
evidence-delivery experiment, not a complete agent workflow, skill selection test,
EXE analysis test, or broad model-quality evaluation.

| Measure | Full recorded REA JSON | SkillGraph summary + extensions |
| --- | ---: | ---: |
| Input tokens per call | 151,573; 151,573 | 15,662; 15,662 |
| Output tokens per call | 221; 217 | 137; 179 |
| Total input over two calls | 303,146 | 31,324 |
| Total output over two calls | 438 | 316 |
| Correct complete answers | 2/2 | 2/2 |
| Cached input tokens | 0 | 0 |
| Wall time per call, milliseconds | 12,600; 12,712 | 8,230; 8,252 |

Input reduction was **89.67%**, including CLI input overhead. Combined input and
output reduction was **89.58%**. These are observed token counts, not a monetary
bill or a guarantee about plan quota accounting. Reasoning output is already
included in output and is not added twice. Cached input is a subset of input.

The identical question requests seven fields: file count, directory count,
declared file bytes, counts of .gd/.dll/.py, and root SHA256. All seven matched
the independent Python ZIP oracle in every run (28 field matches, four answers).
Repeated fields and runs are not independent task samples. The raw arm must
derive aggregates from records; the focused arm receives deterministic
aggregates. That computation is the optimization being tested.

Each call used an ephemeral session, identical output schema, explicit model and
effort, ignored user config, read-only sandbox and an isolated working directory.
Evidence was supplied through stdin; tools were forbidden by prompt and no tool
items occurred. Order was raw/focused, then focused/raw. There were no retries or
failed inference calls. Complete prompts were 340,892 bytes for raw evidence and
2,091 bytes for focused evidence; exact complete prompt sizes and SHA256
are in the machine-readable results. Original evidence remains available locally;
this focused response is an explicit projection, not a claim of lossless catalog
compression. The complete skill catalog behavior is unchanged.

A separate connectivity probe consumed 15,054 input and 28 output tokens.
Across the probe and four experiment calls, usage was 349,524 input and 782 output
tokens. The probe is excluded from the paired reduction calculation. An attempted
EXE-derived experiment was blocked before inference by automatic approval review;
only the authored fixture was sent in this pilot.

Small sample size, one fixed inventory question, deterministic aggregates,
uncontrolled provider routing and no explicit sampling seed limit inference.
Observed correctness does not establish equal capability on extraction, ambiguous
reasoning, code changes or other skill tasks. Local projection time is outside
the model-call wall times. Context pressure differs deliberately between arms.

## Reproduce

Create the public fixture and its recorded REA inventory following
[the evidence study](evidence-study.md), then run:

```powershell
node scripts/model-usage-study.ts ABSOLUTE_CODEX_EXE ISOLATED_WORKING_DIRECTORY
```

This makes four real model requests and consumes account usage. It requires saved
CLI authentication, the requested model, Node 24+, and the demo input/oracle at
`reports/demo-rea.json` and `reports/demo-oracle.json`. Use an empty isolated
directory. Raw events and stderr are saved under ignored `reports/model-usage`.
Missing usage or unexpected tool events stop execution without automatic retry.
Answer failures are preserved rather than discarded.

Usage is read from `turn.completed.usage`, as described in the
[official non-interactive CLI documentation](https://developers.openai.com/codex/noninteractive).
The public [results JSON](model-usage-results.json) preserves every reported usage
field and the actual answers; raw prompts, credentials and local paper are excluded.
