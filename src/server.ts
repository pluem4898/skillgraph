import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillStore, tokenize } from './core.ts';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const db = new SkillStore(resolve(process.env.SKILLGRAPH_DB || join(project, 'data/skillgraph.sqlite')));
const port = Number(process.env.PORT || 4318);
const assets: Record<string, [string, string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const number = (value: string | null, fallback: number) => value === null ? fallback : Number(value);
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
  try {
    if (req.method !== 'GET') { res.writeHead(405); res.end('GET only'); return; }
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const q = url.searchParams;
    let data: unknown;
    if (url.pathname === '/api/stats') data = db.getStats();
    else if (url.pathname === '/api/skills') data = db.listSkills({ repository: q.get('repository') || undefined, offset: number(q.get('offset'), 0), limit: number(q.get('limit'), 60) });
    else if (url.pathname === '/api/files') data = db.listFiles({ repository: q.get('repository') || undefined, packagePath: q.has('package') ? q.get('package')! : undefined, offset: number(q.get('offset'), 0), limit: number(q.get('limit'), 100) });
    else if (url.pathname === '/api/file') {
      const { text: _text, ...metadata } = db.getFile(q.get('id') || ''); data = metadata;
    } else if (url.pathname === '/api/lines') {
      if (!q.get('hash')) throw Object.assign(new Error('hash is required for a versioned source read'), { code: 'HASH_REQUIRED' });
      const { text, numberedText, ...receipt } = db.readLines(q.get('id') || '', number(q.get('start'), 1), number(q.get('end'), NaN), q.get('hash')!);
      data = q.get('numbered') === 'true' ? { ...receipt, numberedText } : { ...receipt, text };
    } else if (url.pathname === '/api/catalog') {
      const options = { repository: q.get('repository') || undefined, offset: number(q.get('offset'), 0), maxTokens: number(q.get('maxTokens'), 8000) };
      const page = q.get('format') === 'full' ? db.catalog(options) : db.compactCatalog(options);
      if (q.has('catalogHash') && q.get('catalogHash') !== page.catalogHash) throw Object.assign(new Error('Catalog changed; start again at page 1.'), { code: 'STALE_CATALOG' });
      data = page;
    } else if (url.pathname === '/api/resolve') {
      data = db.resolveHandle(q.get('handle') || '', q.get('catalogHash') || '', q.get('repository') || undefined);
    } else if (url.pathname === '/api/selection') {
      const f = db.getFile(q.get('id') || '');
      if (f.text === null) throw Object.assign(new Error('This file is binary; inspect metadata.'), { code: 'BINARY_FILE' });
      data = { id: f.id, sourceTokens: tokenize(f.text), encoding: 'o200k_base', classification: 'offline source tokens, not provider usage', hash: f.hash };
    } else if (url.pathname === '/api/reports') {
      const result: Record<string, unknown> = {};
      const reportPaths = { import: 'data/import.json', benchmark: 'reports/benchmark.json', 'gitskills-import': 'data/gitskills-import.json' };
      for (const [name, relativePath] of Object.entries(reportPaths)) {
        try {
          const p = join(project, relativePath);
          const s = await stat(p);
          if (name === 'benchmark' && s.size > 20_000_000) {
            const summaryPath = join(project, 'reports', 'benchmark-summary.json');
            const summary = JSON.parse(await readFile(summaryPath, 'utf8')) as Record<string, unknown>;
            result[name] = { ...summary, status: 'available_on_disk', bytes: s.size, file: relativePath, summaryOnly: true };
          } else result[name] = s.size <= 20_000_000 ? JSON.parse(await readFile(p, 'utf8')) : { status: 'available_on_disk', bytes: s.size, file: relativePath };
        } catch (error) {
          const e = error as Error & { code?: string };
          result[name] = e.code === 'ENOENT' ? { status: 'not_run' } : { status: 'unavailable', error: e.message };
        }
      }
      data = result;
    } else if (assets[url.pathname]) {
      const [name, type] = assets[url.pathname]; res.writeHead(200, { 'Content-Type': type }); res.end(await readFile(join(project, 'public', name))); return;
    } else { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
  } catch (error) {
    const e = error as Error & { code?: string; details?: Record<string, unknown> };
    res.writeHead(e.code === 'FILE_NOT_FOUND' ? 404 : 400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.code || 'ERROR', message: e.message, details: e.details }));
  }
});
server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(`SkillGraph ready: http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`);
});
function close() { server.close(() => { db.close(); process.exit(0); }); }
process.on('SIGINT', close); process.on('SIGTERM', close);
