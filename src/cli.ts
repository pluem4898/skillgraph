import { resolve } from 'node:path';
import { SkillStore } from './core.ts';
import { packedCatalog, leanSource, leanBatch } from './wire.ts';

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
  node src/cli.ts catalog --wire text [--repository owner/repo]
  node src/cli.ts catalog --wire packed [--repository owner/repo]
  node src/cli.ts catalog --wire packed --knownHash RETAINED_CATALOG_HASH
  node src/cli.ts open --handle s1 --catalogHash HASH --wire lean
  node src/cli.ts open-many --handles s1,s2,s3 --catalogHash HASH --wire lean
  node src/cli.ts open --handle s1 --catalogHash HASH --wire text [--repository owner/repo]
  node src/cli.ts open --handle s1 --catalogHash HASH --reference examples/guide.md --wire text
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
    let cachedCatalog = false;
    if (command === 'stats') result = db.getStats();
    else if (command === 'catalog') {
      if (options.knownHash && Number(options.offset || 0) !== 0) throw Object.assign(new Error('--knownHash requires offset 0 and a fully retained catalog.'), { code: 'INVALID_ARGUMENT' });
      const state = options.knownHash ? db.catalogState(options.repository) : undefined;
      if (state && state.catalogHash === options.knownHash) {
        result = { unchanged: true, total: state.total };
        cachedCatalog = true;
      } else {
        const pageOptions = { repository: options.repository, offset: Number(options.offset || 0), maxTokens: Number(options.maxTokens || 8000) };
        const page = options.format === 'full' ? db.catalog(pageOptions) : db.compactCatalog(pageOptions);
        if (options.catalogHash && options.catalogHash !== page.catalogHash) throw Object.assign(new Error('Catalog changed; restart enumeration from offset 0.'), { code: 'STALE_CATALOG' });
        result = page;
      }
    } else if (command === 'open-many') {
      const handles = (options.handles || '').split(',');
      if (handles.some(handle => !/^s[1-9][0-9]*$/.test(handle)) || new Set(handles).size !== handles.length || options.reference || options.start || options.end) {
        throw Object.assign(new Error('Provide distinct --handles s1,s2; open-many reads complete skills. Read a specific reference with open.'), { code: 'INVALID_ARGUMENT' });
      }
      result = handles.map(handle => db.openHandle(handle, options.catalogHash || '', { repository: options.repository }));
    } else if (command === 'open') {
      result = db.openHandle(options.handle || '', options.catalogHash || '', {
        repository: options.repository, reference: options.reference,
        start: options.start === undefined ? undefined : Number(options.start),
        end: options.end === undefined ? undefined : Number(options.end),
      });
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
    if (cachedCatalog) console.log(JSON.stringify(result));
    else if (options.wire === 'lean') {
      if (command === 'open-many') process.stdout.write(leanBatch(result as ReturnType<SkillStore['openHandle']>[]));
      else if (command === 'open') process.stdout.write(leanSource(result as ReturnType<SkillStore['openHandle']>));
      else throw Object.assign(new Error('--wire lean is supported for open and open-many.'), { code: 'INVALID_ARGUMENT' });
    } else if (options.wire === 'packed') {
      if (command !== 'catalog') throw Object.assign(new Error('--wire packed is supported for compact catalogs only.'), { code: 'INVALID_ARGUMENT' });
      process.stdout.write(packedCatalog(result as ReturnType<SkillStore['compactCatalog']>, Number(options.maxTokens || 8000)));
    } else if (options.wire === 'text') {
      if (command === 'catalog') {
        const page = result as ReturnType<SkillStore['compactCatalog']>;
        process.stdout.write(JSON.stringify({ catalogHash: page.catalogHash, offset: page.offset, returned: page.returned, total: page.total, nextOffset: page.nextOffset, format: page.format }) + '\n' + page.text);
      } else if (command === 'open') {
        const { text, ...receipt } = result as ReturnType<SkillStore['openHandle']>;
        process.stdout.write(JSON.stringify(receipt) + '\n' + text);
      } else throw Object.assign(new Error('--wire text is supported for catalog and open only.'), { code: 'INVALID_ARGUMENT' });
    } else console.log(JSON.stringify(result));
  } catch (error) {
    const e = error as Error & { code?: string; details?: Record<string, unknown> };
    console.error(JSON.stringify({ error: e.code || 'ERROR', message: e.message, details: e.details })); process.exitCode = 1;
  } finally { db.close(); }
}
