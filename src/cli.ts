import { resolve } from 'node:path';
import { SkillStore } from './core.ts';

export function parseArgs(args: string[]) {
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (key.includes('=')) { const at = key.indexOf('='); options[key.slice(0, at)] = key.slice(at + 1); }
      else options[key] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
    } else positionals.push(arg);
  }
  return { options, positionals };
}

const { options, positionals } = parseArgs(process.argv.slice(2));
const command = positionals[0] || 'help';
if (command === 'help' || options.help) {
  console.log(`SkillGraph — complete discovery, original evidence

Run from the project directory (Node 24+):
  node src/cli.ts stats
  node src/cli.ts catalog --maxTokens 8000 --offset 0 [--repository owner/repo]
  node src/cli.ts catalog --offset NEXT --catalogHash HASH [--repository owner/repo]
  node src/cli.ts resolve --handle s1 --catalogHash HASH [--repository owner/repo]
  node src/cli.ts inspect --file FILE_ID
  node src/cli.ts files --repository owner/repo --package path/to/skill --offset 0
  node src/cli.ts read --file FILE_ID --start 1 --end 100 --hash SHA256

All commands accept --db PATH. Catalog entries are never truncated. Follow nextOffset
until null; complete applies to the current declared scope, not to all GitHub.
inspect lists original heading ranges and resolved references. read returns exact
source text; --numbered returns numberedText instead. Hashes pin immutable citations.
Catalog/CLI is data access, not permission to execute downloaded skill scripts.`);
} else {
  const db = new SkillStore(resolve(options.db || 'data/skillgraph.sqlite'));
  try {
    let result: unknown;
    if (command === 'stats') result = db.getStats();
    else if (command === 'catalog') {
      const pageOptions = { repository: options.repository, offset: Number(options.offset || 0), maxTokens: Number(options.maxTokens || 8000) };
      const page = options.format === 'full' ? db.catalog(pageOptions) : db.compactCatalog(pageOptions);
      if (options.catalogHash && options.catalogHash !== page.catalogHash) throw Object.assign(new Error('Catalog changed; restart enumeration from offset 0.'), { code: 'STALE_CATALOG' });
      result = page;
    } else if (command === 'resolve') {
      result = db.resolveHandle(options.handle || '', options.catalogHash || '', options.repository);
    } else if (command === 'files') {
      result = db.listFiles({ repository: options.repository, packagePath: options.package, offset: Number(options.offset || 0), limit: Number(options.limit || 100) });
    } else if (command === 'inspect') {
      const { text: _text, ...metadata } = db.getFile(options.file || ''); result = metadata;
    } else if (command === 'read') {
      if (!options.hash) throw Object.assign(new Error('--hash is required; obtain it from catalog or inspect.'), { code: 'HASH_REQUIRED' });
      const { text, numberedText, ...receipt } = db.readLines(options.file || '', Number(options.start || 1), Number(options.end), options.hash);
      result = options.numbered === 'true' ? { ...receipt, numberedText } : { ...receipt, text };
    } else throw Object.assign(new Error(`Unknown command: ${command}`), { code: 'INVALID_COMMAND' });
    console.log(JSON.stringify(result));
  } catch (error) {
    const e = error as Error & { code?: string; details?: Record<string, unknown> };
    console.error(JSON.stringify({ error: e.code || 'ERROR', message: e.message, details: e.details })); process.exitCode = 1;
  } finally { db.close(); }
}
