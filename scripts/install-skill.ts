import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--target' || !isAbsolute(args[1])) {
  throw new Error('Usage: node scripts/install-skill.ts --target ABSOLUTE_SKILLS_DIRECTORY');
}
const destination = join(resolve(args[1]), 'skillgraph');
if (existsSync(destination)) throw new Error(`Destination already exists; no files changed: ${destination}`);
if (!existsSync(join(root, 'src/cli.ts')) || !existsSync(join(root, 'node_modules'))) {
  throw new Error('Keep the complete checkout and install dependencies with npm ci --ignore-scripts first');
}
mkdirSync(dirname(destination), { recursive: true });
cpSync(join(root, '.agents/skills/skillgraph'), destination, { recursive: true, errorOnExist: true, force: false });
writeFileSync(join(destination, 'references/runtime.md'), [
  '# Runtime location', '',
  'This installed skill uses the retained SkillGraph checkout at:', '',
  '```text', root, '```', '',
  'Set the shell working directory to this exact checkout before running the CLI examples.',
  'Verify src/cli.ts, package.json and installed dependencies exist. Node.js 24+ is required.',
  'Keep the user task project separate. If the checkout moved, report the missing runtime and reinstall.',
  'Corpus data remains in this checkout; this skill copy does not bundle downloaded sources or credentials.', '',
].join('\n'));
console.log(JSON.stringify({ installed: destination, runtime: root, note: 'Reload your agent skills if needed. Discovery and invocation depend on the host; no agent configuration was changed.' }, null, 2));
