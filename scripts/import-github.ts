import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, readdirSync, statSync, createWriteStream, createReadStream } from 'node:fs';
import { resolve, dirname, join, posix, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { t as tarList } from 'tar';
import { SkillStore } from '../src/core.ts';

type RepoConfig = { repository: string; ref?: string; note?: string; maxExpandedBytes?: number };
type Limits = { maxArchiveBytes: number; maxExpandedBytes: number; maxTotalDataBytes: number };
type TreeEntry = { path: string; type: string; mode: string; sha: string; size?: number };
type RepoReport = {
  repository: string; requestedRef: string; commit?: string; treeSha?: string; archive?: string; archiveSha256?: string;
  status: 'pending' | 'complete' | 'partial' | 'failed'; treeVerification: string;
  archiveFiles: number; expectedSkills: string[]; acquiredSkills: string[]; importedPaths: string[];
  missingPaths: string[]; extraPaths: string[]; rejectedEntries: { path: string; reason: string }[];
  failures: { path?: string; error: string }[]; expectedFiles?: number; archiveBytes?: number; expandedBytes?: number;
  expectedPaths?: string[]; importFileIds?: Record<string, string>; unverifiedPaths?: string[];
  archiveMismatches?: string[]; repairedPaths?: { path: string; source: string; gitBlobSha: string }[];
  rebuiltPreviousSnapshot?: { files: number; reason: string };
};

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  const at = argv.indexOf(name);
  if (at < 0) return fallback;
  const value = argv[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function diskBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) return 0;
  return readdirSync(path, { withFileTypes: true }).reduce((n, entry) => n + (entry.isSymbolicLink() ? 0 : diskBytes(join(path, entry.name))), 0);
}
function validRepo(repository: string): boolean { return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository); }
function safeArchivePath(raw: string): string | undefined {
  if (raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return undefined;
  const parts = raw.replace(/\/$/, '').split('/');
  if (parts.some(part => part === '..' || part === '.' || part === '')) return undefined;
  return parts.slice(1).join('/'); // codeload adds exactly one repository directory.
}
async function json<T>(url: string): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'SkillGraph-Research', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${url}: ${(await response.text()).slice(0, 400)}`);
      return await response.json() as T;
    } catch (error) { last = error; }
  }
  throw last;
}
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
async function download(url: string, target: string, limit: number, remaining: number): Promise<void> {
  if (existsSync(target)) {
    if (statSync(target).size > limit) throw new Error(`Cached archive exceeds ${limit} bytes`);
    return;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = `${target}.partial`;
    let output: ReturnType<typeof createWriteStream> | undefined;
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'SkillGraph-Research' }, signal: AbortSignal.timeout(180_000) });
      if (!response.ok || !response.body) throw new Error(`Archive HTTP ${response.status}`);
      const size = Number(response.headers.get('content-length') || 0);
      if (size > limit || size > remaining) throw new Error(`Archive size ${size} exceeds configured download/disk cap`);
      output = createWriteStream(temporary, { flags: 'w' });
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > limit || bytes > remaining) throw new Error(`Archive exceeded configured cap after ${bytes} bytes`);
        if (!output.write(chunk)) await once(output, 'drain');
      }
      output.end();
      await once(output, 'finish');
      renameSync(temporary, target);
      return;
    } catch (error) {
      lastError = error;
      output?.destroy();
      if (existsSync(temporary)) unlinkSync(temporary);
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  throw lastError;
}
async function readSnapshot(path: string, limits: Limits, report: RepoReport): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  let expanded = 0;
  let fatal: Error | undefined;
  const roots = new Set<string>();
  await tarList({ file: path, strict: true, onReadEntry(entry) {
    const raw = entry.path;
    const relative = safeArchivePath(raw);
    roots.add(raw.split('/')[0]);
    if (relative === undefined || roots.size > 1) {
      report.rejectedEntries.push({ path: raw, reason: 'Unsafe archive path or multiple archive roots' });
      entry.resume(); return;
    }
    if (entry.type === 'Directory') { entry.resume(); return; }
    if (entry.type !== 'File' && entry.type !== 'OldFile') {
      report.rejectedEntries.push({ path: relative, reason: `Unsupported entry type ${entry.type}; links are never followed` });
      entry.resume(); return;
    }
    expanded += entry.size;
    if (expanded > limits.maxExpandedBytes) { fatal = new Error(`Expanded archive exceeds ${limits.maxExpandedBytes} bytes`); entry.resume(); return; }
    if (files.has(relative)) { fatal = new Error(`Duplicate archive path: ${relative}`); entry.resume(); return; }
    const chunks: Buffer[] = [];
    entry.on('data', (chunk: Buffer) => { if (!fatal) chunks.push(chunk); });
    entry.on('end', () => { if (!fatal) files.set(relative, Buffer.concat(chunks)); });
  } });
  report.expandedBytes = expanded;
  if (fatal) throw fatal;
  return files;
}
function isText(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(buffer); return true; } catch { return false; }
}
function nearestPackage(path: string, roots: Set<string>): string {
  let at = posix.dirname(path);
  for (;;) {
    if (roots.has(at)) return at === '.' ? '' : at;
    if (at === '.') return '';
    at = posix.dirname(at);
  }
}

async function main(): Promise<void> {
  if (argv.includes('--help')) {
    console.log('Usage: node scripts/import-github.ts [--db data/skillgraph.sqlite] [--repos owner/repo,owner/repo] [--config config/corpus.json] [--ref COMMIT_OR_BRANCH]\nDownloads pinned archives, imports every regular repository file, and writes data/import.json. Does not install or execute imported skills. Limits are configured in corpus.json. --ref applies only with one --repos value.');
    return;
  }
  const configPath = resolve(project, arg('--config', 'config/corpus.json')!);
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { repositories: RepoConfig[]; limits: Limits };
  const repositories: RepoConfig[] = arg('--repos')?.split(',').filter(Boolean).map(repository => ({ ...config.repositories.find(source => source.repository === repository), repository, ref: arg('--ref', 'HEAD') })) ?? config.repositories;
  if (!repositories.length || repositories.some(repo => !validRepo(repo.repository))) throw new Error('Expected one or more valid owner/repo identifiers');
  if (arg('--ref') && repositories.length !== 1) throw new Error('--ref requires exactly one repository');
  const database = resolve(project, arg('--db', 'data/skillgraph.sqlite')!);
  const dataPath = dirname(database);
  mkdirSync(dataPath, { recursive: true });
  const archiveDirectory = join(dataPath, 'repos');
  mkdirSync(archiveDirectory, { recursive: true });
  const store = new SkillStore(database);
  const reportPath = join(dataPath, 'import.json');
  const startedAt = new Date().toISOString();
  const selectedRepos = new Set(repositories.map(source => source.repository));
  const previous = arg('--repos') && existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, 'utf8')) as { repositories: RepoReport[] }).repositories : [];
  const reports: RepoReport[] = previous.filter(report => !selectedRepos.has(report.repository));
  const save = () => writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, startedAt, updatedAt: new Date().toISOString(), scope: 'Every regular file in the specified pinned repository snapshots; not all GitHub skills.', configPath, limits: config.limits, repositories: reports, stats: store.getStats() }, null, 2));
  try {
    for (const source of repositories) {
      const report: RepoReport = { repository: source.repository, requestedRef: source.ref ?? 'HEAD', status: 'pending', treeVerification: 'not_attempted', archiveFiles: 0, expectedSkills: [], acquiredSkills: [], importedPaths: [], missingPaths: [], extraPaths: [], rejectedEntries: [], failures: [] };
      reports.push(report); save();
      console.log(`PIN ${source.repository}`);
      try {
        const pin = await json<{ sha: string; commit: { tree: { sha: string } } }>(`https://api.github.com/repos/${source.repository}/commits/${encodeURIComponent(report.requestedRef)}`);
        if (!/^[a-f0-9]{40}$/.test(pin.sha)) throw new Error('GitHub did not return a full commit SHA');
        report.commit = pin.sha; report.treeSha = pin.commit.tree.sha;
        let tree: TreeEntry[] | undefined;
        try {
          const response = await json<{ tree: TreeEntry[]; truncated: boolean }>(`https://api.github.com/repos/${source.repository}/git/trees/${pin.commit.tree.sha}?recursive=1`);
          if (response.truncated) { report.treeVerification = 'truncated'; report.failures.push({ error: 'GitHub recursive tree was truncated; repository-wide completeness is not verified' }); }
          else { tree = response.tree; report.treeVerification = 'available'; }
        } catch (error) { report.treeVerification = 'unavailable'; report.failures.push({ error: `Independent tree verification: ${errorText(error)}` }); }
        const archive = join(archiveDirectory, `${source.repository.replace('/', '--')}--${pin.sha}.tar.gz`);
        await download(`https://codeload.github.com/${source.repository}/tar.gz/${pin.sha}`, archive, config.limits.maxArchiveBytes, config.limits.maxTotalDataBytes - diskBytes(dataPath));
        report.archive = archive; report.archiveBytes = statSync(archive).size; report.archiveSha256 = await hashFile(archive);
        const files = await readSnapshot(archive, { ...config.limits, maxExpandedBytes: source.maxExpandedBytes ?? config.limits.maxExpandedBytes }, report);
        report.archiveFiles = files.size;
        if (diskBytes(dataPath) + (report.expandedBytes ?? 0) * 2 > config.limits.maxTotalDataBytes) throw new Error('Import would exceed total disk cap, including a conservative SQLite/index allowance');
        const skillPaths = [...files.keys()].filter(path => /(^|\/)SKILL\.md$/i.test(path)).sort();
        const roots = new Set(skillPaths.map(path => posix.dirname(path)));
        const expected = tree?.filter(entry => entry.type === 'blob' && entry.mode !== '120000');
        if (expected) {
          report.expectedPaths = expected.map(entry => entry.path).sort();
          report.expectedFiles = expected.length;
          report.expectedSkills = report.expectedPaths.filter(path => /(^|\/)SKILL\.md$/i.test(path));
          const expectedSet = new Set(report.expectedPaths);
          report.missingPaths = report.expectedPaths.filter(path => !files.has(path));
          report.extraPaths = [...files.keys()].filter(path => !expectedSet.has(path)).sort();
          report.unverifiedPaths = [];
          report.archiveMismatches = [];
          report.repairedPaths = [];
          for (const entry of expected) {
            const content = files.get(entry.path);
            if (!content) continue;
            const hash = createHash('sha1').update(`blob ${content.byteLength}\0`).update(content).digest('hex');
            if (hash !== entry.sha) {
              report.archiveMismatches.push(entry.path);
              const canonicalPath = join(dataPath, 'canonical-blobs', entry.sha);
              const rawUrl = `https://raw.githubusercontent.com/${source.repository}/${pin.sha}/${entry.path.split('/').map(encodeURIComponent).join('/')}`;
              try {
                mkdirSync(dirname(canonicalPath), { recursive: true });
                await download(rawUrl, canonicalPath, source.maxExpandedBytes ?? config.limits.maxExpandedBytes, config.limits.maxTotalDataBytes - diskBytes(dataPath));
                const canonical = readFileSync(canonicalPath);
                const canonicalHash = createHash('sha1').update(`blob ${canonical.length}\0`).update(canonical).digest('hex');
                if (canonicalHash !== entry.sha) throw new Error('Canonical raw response does not match Git blob hash');
                files.set(entry.path, canonical);
                report.repairedPaths.push({ path: entry.path, source: rawUrl, gitBlobSha: entry.sha });
              } catch (error) { report.unverifiedPaths.push(entry.path); report.failures.push({ path: entry.path, error: `Canonical byte repair failed: ${errorText(error)}` }); }
            }
          }
          if (report.unverifiedPaths.length) report.failures.push({ error: `${report.unverifiedPaths.length} source files remain unverified and will not be imported` });
          report.treeVerification = report.missingPaths.length || report.extraPaths.length || report.unverifiedPaths.length ? 'mismatch' : 'verified';
          const unsupported = tree!.filter(entry => entry.type === 'commit' || entry.mode === '120000');
          for (const entry of unsupported) if (!report.rejectedEntries.some(rejected => rejected.path === entry.path)) report.rejectedEntries.push({ path: entry.path, reason: entry.mode === '120000' ? 'Symlink excluded; never followed' : 'Git submodule excluded; not a regular repository file' });
        } else report.expectedSkills = skillPaths; // explicitly archive-scoped, independent tree verification unavailable.
        if (argv.includes('--rebuild-repository')) {
          if (!arg('--repos') || repositories.length !== 1 || report.treeVerification !== 'verified') throw new Error('--rebuild-repository requires exactly one --repos snapshot with fully verified bytes');
          const repair = new DatabaseSync(database);
          try {
            repair.exec('PRAGMA busy_timeout=10000; BEGIN IMMEDIATE;');
            const deleted = repair.prepare('DELETE FROM files WHERE repository=? AND commit_sha=?').run(source.repository, pin.sha);
            repair.exec('DELETE FROM blobs WHERE hash NOT IN (SELECT hash FROM files); COMMIT;');
            report.rebuiltPreviousSnapshot = { files: Number(deleted.changes), reason: 'Explicit rebuild after replacing archive-export byte changes with verified canonical Git blobs' };
          } catch (error) { repair.exec('ROLLBACK'); throw error; } finally { repair.close(); }
        }
        report.importFileIds = {};
        for (const path of [...files.keys()].sort()) {
          if (report.unverifiedPaths?.includes(path)) continue;
          const content = files.get(path)!;
          const kind = /(^|\/)SKILL\.md$/i.test(path) ? 'skill' : isText(content) ? 'reference' : 'asset';
          try {
            const id = store.importFile({ repository: source.repository, commit: pin.sha, path, content, kind, packagePath: nearestPackage(path, roots) });
            report.importedPaths.push(path); report.importFileIds[path] = id;
            if (kind === 'skill') report.acquiredSkills.push(path);
          } catch (error) { report.failures.push({ path, error: errorText(error) }); }
        }
        report.status = report.failures.length || report.rejectedEntries.length || report.missingPaths.length || report.treeVerification !== 'verified' ? 'partial' : 'complete';
        if (diskBytes(dataPath) > config.limits.maxTotalDataBytes) { report.status = 'partial'; report.failures.push({ error: 'Total data disk cap exceeded by SQLite/index overhead; no further repositories imported' }); save(); break; }
        console.log(`${report.status.toUpperCase()} ${source.repository}@${pin.sha.slice(0, 12)}: ${report.acquiredSkills.length} skills, ${report.importedPaths.length} files, tree=${report.treeVerification}`);
      } catch (error) { report.status = 'failed'; report.failures.push({ error: errorText(error) }); console.error(`FAILED ${source.repository}: ${errorText(error)}`); }
      save();
    }
    save();
    const stats = store.getStats();
    console.log(JSON.stringify({ report: reportPath, stats: { ...stats, repositories: stats.repositories.length }, complete: reports.filter(report => report.status === 'complete').length, partial: reports.filter(report => report.status === 'partial').length, failed: reports.filter(report => report.status === 'failed').length }, null, 2));
    if (reports.some(report => report.status === 'failed')) process.exitCode = 1;
  } finally { store.close(); }
}

main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
