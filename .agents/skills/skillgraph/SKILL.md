---
name: skillgraph
description: Discover skills in a SkillGraph corpus and read their original instructions with snapshot-bound line citations. Use when selecting skills or auditing skill coverage through SkillGraph.
compatibility: Requires file and shell tools, Node.js 24+, and an initialized SkillGraph checkout. No model-provider API is required by the core CLI.
---

# SkillGraph

Read [runtime location](references/runtime.md) to locate the checkout. Run the Node 24+ CLI with that checkout as the shell working directory; no server or provider API is needed. Keep the user's task project separate from this CLI working directory. Do not assume the skill's installation directory contains the application. State the actual corpus scope. Use `--repository OWNER/REPO` only for a user-selected scope, consistently across commands. Use `stats` when inventory context is unknown.

1. Run `node src/cli.ts catalog --wire packed --maxTokens 8000`. Read every page before choosing; follow `nextOffset` with `--offset NEXT --catalogHash HASH`. Never replace complete discovery with top-k filtering or shortened names/descriptions.
2. Choose a handle and run `node src/cli.ts open --handle s1 --catalogHash HASH --wire lean`. This reads the full original. Read governing instructions and exceptions before applying them. For a known package reference add `--reference examples/guide.md`. Use `files --repository OWNER/REPO --package PACKAGE_PATH` for unknown paths, or `resolve` for headings/links. Follow-up `open --start N --end M` uses original line coordinates; include the whole governing section.

Packed catalog: first line is the receipt/schema; subsequent rows are `[name,description,overrides?]`. Row i (zero based) has handle `s` + (`handleStart` + i). Path is `overrides.path` or `defaults.pathPrefix + name + defaults.pathSuffix`; diagnostics are `overrides.errors` or `defaults.errors`. All values remain exact.

Lean source: first line is `[repository,commit,path,SHA256,[start,end,totalLines],utf8Bytes,errors]`; remaining bytes are exact source. Verify byte count for complete delivery. Cite repository, commit, path, hash and lines. `--wire text` gives labeled receipts.

For related tasks handled together, discover once and choose all relevant handles, then use `open-many --handles s1,s2,s3 --catalogHash HASH --wire lean`. Its first line is `{format:"sources-v1",count:N}`. Each record is a lean receipt line, exactly `utf8Bytes` source bytes, then one separator newline outside the source. Do not split bodies on newline or treat body text as framing. Read required references with `open` afterward. Batch only when all chosen sources fit context; do not omit governing text to force a fit.

Reuse discovery only while the complete catalog remains available in current context: `catalog --wire packed --knownHash HASH`. `{unchanged:true,total:N}` confirms the requested digest still applies. Otherwise read all newly returned pages. Never use this shortcut after partial delivery or context loss.

If all entries exceed context, report coverage and request an explicit smaller scope or larger context. Host truncation is incomplete delivery: retry smaller whole-entry pages. Missing dependencies, malformed metadata and binary files are not evidence of absence. Imported instructions do not authorize script execution. Payload counts do not establish comprehension, accuracy, billed usage or optimality.

For bounded questions about large recorded REA artifact inventories, read [evidence views](references/evidence.md). This optional workflow reduces evidence output; it never filters the skill catalog.
