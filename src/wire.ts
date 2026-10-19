import { SkillStoreError, tokenize, type CatalogPage } from './core.ts';

/** Lossless catalog factoring. Handles follow row ordinals; conventional paths
 * and empty diagnostics are declared once. Exceptions remain explicit. */
export function packedCatalog(page: CatalogPage, maxTokens = 8000): string {
  if (page.format !== 'compact') throw new SkillStoreError('INVALID_ARGUMENT', 'Packed wire requires compact catalog format');
  const rows = page.text.trimEnd().split('\n').slice(1).map(line => {
    const [handle, name, description, path, errors] = JSON.parse(line);
    const overrides: { path?: string; errors?: string[] } = {};
    if (path !== `skills/${name}/SKILL.md`) overrides.path = path;
    if (errors.length) overrides.errors = errors;
    return { handle, data: Object.keys(overrides).length ? [name, description, overrides] : [name, description] };
  });
  rows.forEach((row, i) => {
    if (row.handle !== `s${page.offset + i + 1}`) throw new SkillStoreError('INVALID_HANDLE', 'Catalog ordinal does not match handle');
  });
  const render = () => JSON.stringify({ format: 'packed-v1', catalogHash: page.catalogHash,
    offset: page.offset, returned: rows.length, total: page.total,
    nextOffset: rows.length < page.returned ? page.offset + rows.length : page.nextOffset,
    handleStart: page.offset + 1, columns: ['name', 'description', 'overrides?'],
    defaults: { pathPrefix: 'skills/', pathSuffix: '/SKILL.md', errors: [] } }) + '\n' +
    rows.map(row => JSON.stringify(row.data) + '\n').join('');
  let text = render();
  while (tokenize(text) > maxTokens && rows.length > 1) { rows.pop(); text = render(); }
  if (tokenize(text) > maxTokens) throw new SkillStoreError(rows.length ? 'ENTRY_TOO_LARGE' : 'CATALOG_HEADER_TOO_LARGE',
    'The complete packed response exceeds the budget; nothing was truncated', { requiredTokens: tokenize(text) });
  return text;
}
