# Large recorded REA inventory evidence

Use this only for bounded questions about an existing REA artifact inventory.
It does not replace complete skill discovery or analyze an executable itself.

```powershell
node src/cli.ts evidence --input reports/rea.json --view summary --cache data/evidence
node src/cli.ts evidence --input reports/rea.json --view extensions --cache data/evidence
node src/cli.ts evidence --input reports/rea.json --view files --extension .gd --offset 0 --limit 100 --cache data/evidence
node src/cli.ts evidence --input reports/rea.json --view record --index 42 --cache data/evidence
```

`files` returns whole records with original paths, byte counts, full SHA-256 and
`sourceIndex`. Follow every `nextOffset` for a complete selected inventory.
Use `record` to retrieve the original occurrence and artifact fields for that
index. Cite `sourceHash`, `evidenceId`, `evidencePointer` and occurrence index.

Source coverage, limitations and path warnings remain visible. Counts describe
producer-reported occurrences, not confirmed filesystem extraction. A literal
backslash in ZIP names can be interpreted differently by different extractors;
do not silently normalize paths or treat a warning as a verified directory.

The full UTF-8 JSON is retained under its SHA-256 in the cache directory. Cache
keys include source bytes, adapter version and exact normalized query. Changed
inputs invalidate derived results; damaged cached data raises an explicit error.
Cache does not guarantee lower response tokens than the same focused view
computed without caching. Do not infer unsupported facts from an omitted field;
inspect the original record or full retained source when the question requires it.

Inventory projections preserve the fields needed for declared queries, not all
raw fields inline. They do not establish semantic AI accuracy, executable safety,
successful installation, whole-task model token savings or universal speedups.
