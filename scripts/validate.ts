import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve('reports/retest');
mkdirSync(out, { recursive: true });
const checks = [
  { name: 'automated-tests', args: ['--test', '--test-reporter=tap', ...readdirSync('tests').filter(file => file.endsWith('.test.ts')).sort().map(file => `tests/${file}`)] },
  { name: 'typescript', args: ['node_modules/typescript/bin/tsc', '--noEmit'] },
  { name: 'browser-script-syntax', args: ['--check', 'public/app.js'] },
];
const results = checks.map(check => {
  const start = performance.now();
  const run = spawnSync(process.execPath, check.args, { encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 16_000_000 });
  const log = run.stdout + run.stderr;
  writeFileSync(resolve(out, `${check.name}.log`), log);
  return { name: check.name, command: [process.execPath, ...check.args], exitCode: run.status, status: run.status === 0 ? 'passed' : 'failed', wallSeconds: (performance.now() - start) / 1000, logSha256: createHash('sha256').update(log).digest('hex'), testCount: check.name === 'automated-tests' ? Number(/# tests (\d+)/.exec(log)?.[1] || 0) : undefined };
});
const report = { checkedAt: new Date().toISOString(), runtime: process.version, platform: process.platform, architecture: process.arch, classification: 'Local software validation; timings are not model inference latency.', checks: results, status: results.every(result => result.status === 'passed') ? 'passed' : 'failed' };
writeFileSync(resolve(out, 'validation.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'passed') process.exitCode = 1;
