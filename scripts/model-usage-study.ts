import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { queryEvidence } from '../src/evidence.ts';

// Real CLI usage; raw prompts/events stay in ignored reports/. No synthetic usage.
const [codex, isolatedCwd] = process.argv.slice(2);
if (!codex || !isolatedCwd) throw new Error('Usage: node scripts/model-usage-study.ts CODEX_EXE ISOLATED_CWD');
const out = resolve('reports/model-usage'); mkdirSync(out, { recursive: true });
const keys = ['file_count', 'directory_count', 'declared_file_bytes', 'gd_count', 'dll_count', 'py_count', 'root_sha256'];
const schema = { type: 'object', properties: Object.fromEntries(keys.map(k => [k, { type: k === 'root_sha256' ? 'string' : 'integer' }])), required: keys, additionalProperties: false };
const schemaPath = resolve(out, 'answer-schema.json'); writeFileSync(schemaPath, JSON.stringify(schema));
const results: any[] = [];
for (const [name, input, oraclePath] of [
  ['authored-demo', 'reports/demo-rea.json', 'reports/demo-oracle.json'],
]) {
  const independent = JSON.parse(readFileSync(oraclePath, 'utf8')); const oracle = independent.rawHeader;
  const count = (ext: string) => oracle.extensions.find((e: any) => e.extension === ext)?.count ?? 0;
  const expected = { file_count: oracle.files.length, directory_count: oracle.directories, declared_file_bytes: oracle.fileBytes, gd_count: count('.gd'), dll_count: count('.dll'), py_count: count('.py'), root_sha256: independent.archiveSha256 };
  for (let repeat = 0; repeat < 2; repeat++) for (const arm of repeat === 0 ? ['raw', 'skillgraph'] : ['skillgraph', 'raw']) {
    const evidence = arm === 'raw' ? readFileSync(input, 'utf8') : JSON.stringify([queryEvidence(resolve(input), { view: 'summary' }), queryEvidence(resolve(input), { view: 'extensions' })]);
    const prompt = 'Use only the evidence below. Do not use tools, files, network, or environment. Return the required JSON. Count non-root file and directory occurrences; exclude the root container. Sum declared sizes of file occurrences. Count .gd, .dll and .py files using case-insensitive final suffix. Preserve literal producer paths, including backslashes; do not reinterpret directory markers. Return the root archive SHA256.\nEVIDENCE\n' + evidence;
    const id = `${name}-${repeat + 1}-${arm}`; const start = Date.now();
    const run = spawnSync(codex, ['exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check', '-C', resolve(isolatedCwd), '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="ultra"', '--output-schema', schemaPath, '-'], { input: prompt, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 32_000_000 });
    writeFileSync(resolve(out, id + '.jsonl'), run.stdout ?? ''); writeFileSync(resolve(out, id + '.stderr.txt'), run.stderr ?? '');
    const events = (run.stdout ?? '').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const usage = events.find(e => e.type === 'turn.completed')?.usage ?? null;
    const messages = events.filter(e => e.type === 'item.completed' && e.item.type === 'agent_message');
    let answer: any = null; try { answer = JSON.parse(messages.at(-1)?.item.text ?? ''); } catch {}
    const toolItems = events.filter(e => e.type === 'item.completed' && !['agent_message', 'reasoning'].includes(e.item.type)).map(e => e.item.type);
    const result = { id, case: name, repeat: repeat + 1, arm, requestedModel: 'gpt-6-astra', reasoningEffort: 'ultra', wallMs: Date.now() - start, exitCode: run.status, error: run.error?.message ?? null, promptSha256: createHash('sha256').update(prompt).digest('hex'), promptBytes: Buffer.byteLength(prompt), usage, answer, correct: isDeepStrictEqual(answer, expected), toolItems };
    results.push(result); writeFileSync(resolve(out, 'results.json'), JSON.stringify({ scope: 'Authored synthetic evidence-delivery task only; two repeats per arm; no automatic retries', results }, null, 2));
    console.log(JSON.stringify(result));
    if (!usage || toolItems.length) throw new Error('Incomplete usage or protocol violation; stopping without retry');
  }
}
