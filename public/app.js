'use strict';

const $ = (id) => document.getElementById(id);
const number = (value) => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value) : '—';
const state = { repository: '', offset: 0, nextOffset: null, total: 0, pageSize: 30, file: null, lines: null, history: [], listRequest: 0, fileRequest: 0, lineRequest: 0, tokenCounts: new Map(), reports: null, catalog: null, catalogOffsets: [0], catalogIndex: 0, catalogHash: null, catalogRequest: 0, catalogBudget: 8000, catalogFormat: 'compact' };
let toastTimer;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className, handler) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}
async function api(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  const response = await fetch(`${path}${query.size ? `?${query}` : ''}`);
  const result = await response.json();
  if (!response.ok) {
    const details = result.details && Object.keys(result.details).length ? `\n${JSON.stringify(result.details)}` : '';
    throw new Error(`${result.error || response.status}: ${result.message || response.statusText}${details}`);
  }
  return result;
}
function toast(text) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { toast('Automatic copy unavailable. Select the text and press Ctrl+C.'); }
}
function showError(target, error) { target.textContent = error.message || String(error); target.hidden = false; }
function empty(message, detail) {
  const box = element('div', 'empty-state');
  box.append(element('span', 'empty-symbol', '◇'), element('strong', '', message));
  if (detail) box.append(element('p', '', detail));
  return box;
}
function setTab(name) {
  for (const tab of ['explore', 'experiments']) {
    const active = name === tab;
    $(`${tab}-view`).hidden = !active;
    $(`${tab}-tab`).classList.toggle('active', active);
    if (active) $(`${tab}-tab`).setAttribute('aria-current', 'page');
    else $(`${tab}-tab`).removeAttribute('aria-current');
  }
  if (name === 'experiments' && !state.reports) loadReports();
}

async function loadStats() {
  const stats = await api('/api/stats');
  $('stat-skills').textContent = number(stats.skills);
  $('stat-repos').textContent = number(stats.repositories.length);
  $('stat-files').textContent = number(stats.files);
  $('stat-errors').textContent = number(stats.errors);
  $('stat-references').textContent = `${number(stats.references)} references · ${number(stats.assets)} assets`;
  const options = [element('option', '', 'All imported repositories')];
  options[0].value = '';
  for (const repository of stats.repositories) { const option = element('option', '', repository); option.value = repository; options.push(option); }
  $('repository').replaceChildren(...options);
  $('repository').value = state.repository;
}

async function loadSkills(offset = 0, selectFirst = false) {
  const request = ++state.listRequest;
  $('skill-list').replaceChildren(element('div', 'loading', 'Loading every entry on this page…'));
  $('skill-list').setAttribute('aria-busy', 'true');
  $('list-prev').disabled = true;
  $('list-next').disabled = true;
  $('list-range').textContent = 'Loading…';
  try {
    const page = await api('/api/skills', { offset, limit: state.pageSize, repository: state.repository });
    if (request !== state.listRequest) return;
    state.offset = offset; state.total = page.total; state.nextOffset = page.nextOffset;
    $('catalog-total').textContent = `${number(page.total)} skills`;
    $('list-range').textContent = page.total ? `${number(offset + 1)}–${number(offset + page.items.length)} / ${number(page.total)}` : '0 / 0';
    $('list-page').value = String(Math.floor(offset / state.pageSize) + 1);
    $('list-page').max = String(Math.max(1, Math.ceil(page.total / state.pageSize)));
    $('list-pages').textContent = `/ ${number(Math.max(1, Math.ceil(page.total / state.pageSize)))}`;
    $('list-prev').disabled = offset === 0;
    $('list-next').disabled = page.nextOffset === null;
    $('skill-list').replaceChildren();
    for (const skill of page.items) {
      const card = button('', 'skill-card', () => openFile(skill.id));
      card.dataset.fileId = skill.id;
      card.setAttribute('aria-pressed', String(state.file?.id === skill.id));
      card.classList.toggle('selected', state.file?.id === skill.id);
      const title = element('div', 'card-top');
      title.append(element('h3', '', skill.name || skill.path), element('span', 'card-arrow', '↗'));
      const meta = element('div', 'card-meta');
      meta.append(element('span', '', skill.repository), element('span', '', `${number(skill.totalLines)} lines`));
      if (skill.errors.length) meta.append(element('span', 'diagnostic-count', `${skill.errors.length} diagnostics`));
      card.append(title, element('p', '', skill.description || 'No readable description. Inspect the original source and diagnostics.'), meta);
      $('skill-list').append(card);
    }
    if (!page.items.length) $('skill-list').append(empty('No entries in this scope', 'Imported entries appear here without relevance ranking.'));
    $('skill-list').scrollTop = 0;
    if (selectFirst && page.items[0]) openFile(page.items[0].id);
  } catch (error) {
    if (request !== state.listRequest) return;
    $('list-range').textContent = 'List unavailable';
    const box = empty('Catalog unavailable', error.message);
    box.append(button('Retry', 'button secondary', () => loadSkills(offset, selectFirst)));
    $('skill-list').replaceChildren(box);
  } finally { if (request === state.listRequest) $('skill-list').removeAttribute('aria-busy'); }
}

async function openFile(id, remember = true) {
  const request = ++state.fileRequest;
  ++state.lineRequest;
  if (remember && state.file && state.file.id !== id) state.history.push({ id: state.file.id, start: state.lines?.startLine || 1 });
  state.file = null;
  state.lines = null;
  $('source-name').textContent = 'Opening source…';
  $('source-path').textContent = 'Checking file ID and hash';
  $('source-version').textContent = 'Loading snapshot';
  $('source-encoding').textContent = '…';
  $('inspector').replaceChildren(element('div', 'loading', 'Loading evidence…'));
  $('source-content').replaceChildren(element('div', 'loading', 'Verifying source snapshot…'));
  $('source-content').setAttribute('aria-busy', 'true');
  $('source-notice').hidden = true;
  $('copy-lines').disabled = true;
  $('source-prev').disabled = true;
  $('source-next').disabled = true;
  $('jump-line').disabled = true;
  $('jump-button').disabled = true;
  try {
    const file = await api('/api/file', { id });
    if (request !== state.fileRequest) return;
    state.file = file;
    $('source-name').textContent = file.name || file.path.split('/').pop();
    $('source-path').textContent = `${file.repository} / ${file.path}`;
    $('source-kind').textContent = file.kind.toUpperCase();
    $('source-version').textContent = file.commit.startsWith('dataset:') ? 'Dataset snapshot · upstream commit unknown' : `commit ${file.commit.slice(0, 12)}`;
    $('source-version').title = file.commit;
    $('source-encoding').textContent = `${file.encoding} · ${number(file.size)} bytes`;
    $('source-back').hidden = !state.history.length;
    for (const card of document.querySelectorAll('.skill-card')) { const selected = card.dataset.fileId === id; card.classList.toggle('selected', selected); card.setAttribute('aria-pressed', String(selected)); }
    renderInspector();
    if (file.encoding !== 'utf-8') {
      $('line-range').textContent = 'BINARY SOURCE';
      $('source-content').replaceChildren(empty('Original bytes preserved', 'This file is not readable as UTF-8. Its original bytes, metadata, and hash remain in the store.'));
    } else if (!file.totalLines) {
      $('line-range').textContent = '0 / 0 lines';
      $('source-content').replaceChildren(empty('Empty source file', 'This occurrence remains in the catalog with its snapshot and hash.'));
    } else {
      $('jump-line').disabled = false;
      $('jump-button').disabled = false;
      $('jump-line').max = String(file.totalLines);
      await loadLines(1);
    }
  } catch (error) {
    if (request !== state.fileRequest) return;
    state.file = null;
    $('source-name').textContent = 'Source unavailable';
    $('source-path').textContent = id;
    $('source-content').replaceChildren(empty('Source unavailable', error.message));
    $('line-range').textContent = 'SOURCE UNAVAILABLE';
    $('inspector').replaceChildren(empty('Evidence unavailable', error.message));
  } finally { if (request === state.fileRequest) $('source-content').removeAttribute('aria-busy'); }
}

async function loadLines(start, highlightEnd) {
  const file = state.file;
  if (!file || !file.totalLines || file.encoding !== 'utf-8') return;
  if (!Number.isSafeInteger(start) || start < 1 || start > file.totalLines) { toast(`Line must be between 1–${file.totalLines}`); return; }
  const request = ++state.lineRequest;
  $('source-content').setAttribute('aria-busy', 'true');
  $('copy-lines').disabled = true;
  $('source-prev').disabled = true;
  $('source-next').disabled = true;
  $('line-range').textContent = 'Loading source lines…';
  $('source-notice').hidden = true;
  const end = Math.min(start + 199, file.totalLines);
  try {
    const lines = await api('/api/lines', { id: file.id, start, end, hash: file.hash });
    if (request !== state.lineRequest || state.file?.id !== file.id) return;
    state.lines = lines;
    const source = lines.text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) || [];
    const fragment = document.createDocumentFragment();
    const headingStarts = new Set(file.headings.map((heading) => heading.startLine));
    source.forEach((text, index) => {
      const line = lines.startLine + index;
      const row = element('div', 'line-row');
      if (headingStarts.has(line)) row.classList.add('is-heading');
      if (highlightEnd && line <= highlightEnd) row.classList.add('is-highlighted');
      row.id = `line-${line}`;
      const numberNode = element('span', 'line-number', String(line));
      numberNode.setAttribute('aria-hidden', 'true');
      row.append(numberNode, element('span', 'line-text', text.replace(/(?:\r\n|\r|\n)$/, '') || ' '));
      fragment.append(row);
    });
    $('source-content').replaceChildren(fragment);
    $('source-content').scrollTop = 0;
    $('source-content').scrollLeft = 0;
    $('line-range').textContent = `L${lines.startLine}–${lines.endLine} / ${number(lines.totalLines)}`;
    $('jump-line').value = String(lines.startLine);
    $('source-prev').disabled = lines.startLine <= 1;
    $('source-next').disabled = lines.endLine >= lines.totalLines;
    $('copy-lines').disabled = false;
    if (highlightEnd && highlightEnd > end) { $('source-notice').textContent = `This section ends at line ${highlightEnd} · Showing ${start}–${end} · Use → to continue`; $('source-notice').hidden = false; }
    renderInspector();
  } catch (error) {
    if (request !== state.lineRequest) return;
    state.lines = null;
    $('source-content').replaceChildren(empty('Line range unavailable', error.message));
    $('line-range').textContent = 'READ FAILED';
    renderInspector();
  } finally { if (request === state.lineRequest) $('source-content').removeAttribute('aria-busy'); }
}

function section(title) { const node = element('section', 'inspector-section'); node.append(element('h3', '', title)); return node; }
function citation() {
  if (!state.file || !state.lines) return null;
  return { fileId: state.file.id, repository: state.file.repository, commit: state.file.commit, path: state.file.path, hash: state.file.hash, startLine: state.lines.startLine, endLine: state.lines.endLine };
}
function renderInspector() {
  const file = state.file;
  if (!file) return;
  const parts = [];
  const identity = section('IMMUTABLE SOURCE');
  const list = element('dl', 'detail-list');
  const dataset = file.commit.startsWith('dataset:');
  for (const [label, value] of [['Repository', file.repository], [dataset ? 'Dataset revision' : 'Commit', file.commit], ['SHA-256', file.hash], ['File ID', file.id]]) list.append(element('dt', '', label), element('dd', '', value));
  if (dataset) identity.append(element('p', 'help', 'This source is pinned to a dataset snapshot. The upstream repository commit is unknown. Supporting files reflect the dataset and may be incomplete. See Experiments for coverage.'));
  identity.append(list); parts.push(identity);

  const evidence = section('CITATION / CURRENT RANGE');
  const current = citation();
  if (current) {
    evidence.append(element('pre', 'citation-box', `${file.path}\nL${current.startLine}–L${current.endLine} / ${number(file.totalLines)} lines\n${dataset ? 'dataset revision' : 'commit'} ${file.commit}\nhash ${file.hash}`));
    evidence.append(button('Copy citation JSON ↗', 'button secondary wide-button', () => copy(JSON.stringify(citation(), null, 2))));
  } else evidence.append(element('p', 'help', 'No source range has been read successfully.'));
  parts.push(evidence);

  const tokens = section('SOURCE TOKEN COUNT');
  if (state.tokenCounts.has(file.id)) {
    const count = element('div', 'token-readout'); count.append(element('span', '', 'o200k_base'), element('strong', '', number(state.tokenCounts.get(file.id)))); tokens.append(count);
  } else {
    const measure = button('Measure source tokens', 'button secondary wide-button', async () => {
      measure.disabled = true; measure.textContent = 'Measuring…';
      try { const result = await api('/api/selection', { id: file.id }); state.tokenCounts.set(file.id, result.sourceTokens); if (state.file?.id === file.id) renderInspector(); }
      catch (error) { toast(error.message); measure.disabled = false; measure.textContent = 'Retry measurement'; }
    });
    measure.disabled = file.encoding !== 'utf-8'; tokens.append(measure);
  }
  tokens.append(element('p', 'help', 'Offline source-text count. Prompt framing, tool overhead, and model output are excluded. Provider usage is unmeasured.'));
  parts.push(tokens);

  const outline = section(`OUTLINE / ${file.headings.length}`);
  for (const heading of file.headings) {
    const link = button('', 'section-link', () => loadLines(heading.startLine, heading.endLine));
    link.append(element('span', '', `${'· '.repeat(Math.min(heading.level - 1, 4))}${heading.title}`), element('span', '', `L${heading.startLine}–${heading.endLine}`));
    outline.append(link);
  }
  if (!file.headings.length) outline.append(element('p', 'help', 'No Markdown headings found.'));
  parts.push(outline);

  const references = section(`SOURCE LINKS / ${file.links.length}`);
  for (const link of file.links) {
    const card = element('div', 'reference-card');
    card.append(element('p', '', link.target || '(empty anchor)'));
    const status = element('div', 'reference-status');
    status.append(element('strong', link.status === 'resolved' ? 'resolved' : '', link.status), button(`L${link.line}`, 'text-button', () => loadLines(link.line, link.line)));
    if (link.status === 'resolved' && link.fileId) status.append(button('Open file ↗', 'text-button', () => openFile(link.fileId)));
    if (link.status === 'external' && /^https?:\/\//i.test(link.target)) {
      const anchor = element('a', '', 'Open URL ↗'); anchor.href = link.target; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; status.append(anchor);
    }
    card.append(status); references.append(card);
  }
  if (!file.links.length) references.append(element('p', 'help', 'No Markdown links found in this file.'));
  references.append(element('p', 'help', 'These are parsed Markdown links. Dependencies mentioned in prose or code may require additional inspection.'));
  parts.push(references);
  const diagnostics = section(`DIAGNOSTICS / ${file.errors.length}`);
  if (file.errors.length) { const errors = element('ul', 'diagnostic-list'); for (const error of file.errors) errors.append(element('li', '', error)); diagnostics.append(errors); }
  else diagnostics.append(element('p', 'help', 'No parser diagnostics for this file.'));
  parts.push(diagnostics);
  $('inspector').replaceChildren(...parts);
}

async function loadCatalog(reset = false, pageIndex = 0) {
  if (reset) { state.catalogOffsets = [0]; state.catalogHash = null; state.catalogBudget = Number($('catalog-budget').value); state.catalogFormat = $('catalog-format').value; pageIndex = 0; }
  const request = ++state.catalogRequest;
  state.catalogIndex = pageIndex;
  $('catalog-status').className = 'notice';
  $('catalog-status').textContent = 'Building payload with every name and description preserved…';
  $('catalog-preview').textContent = '';
  $('catalog-prev').disabled = true; $('catalog-next').disabled = true; $('copy-catalog').disabled = true;
  $('catalog-scope').textContent = state.repository || 'ALL IMPORTED REPOSITORIES';
  try {
    const result = await api('/api/catalog', { repository: state.repository, offset: state.catalogOffsets[pageIndex], maxTokens: state.catalogBudget, format: state.catalogFormat, catalogHash: state.catalogHash });
    if (request !== state.catalogRequest) return;
    state.catalog = result; state.catalogHash = result.catalogHash;
    $('catalog-preview').textContent = result.text;
    $('catalog-status').textContent = `Entries ${result.returned ? result.offset + 1 : 0}–${result.offset + result.returned} / ${number(result.total)} · ${number(result.tokenCount)} tokens · ${state.catalogFormat} · complete: ${result.complete}\nCatalog SHA-256: ${result.catalogHash}${result.nextOffset !== null ? '\nMore pages remain. This response is only part of the catalog.' : result.offset > 0 ? '\nFinal page. This response does not include earlier pages.' : '\nThis response contains all catalog metadata in the declared scope.'} `;
    $('catalog-prev').disabled = pageIndex === 0;
    $('catalog-next').disabled = result.nextOffset === null;
    $('copy-catalog').disabled = false;
    if (result.nextOffset !== null) state.catalogOffsets[pageIndex + 1] = result.nextOffset;
  } catch (error) {
    if (request !== state.catalogRequest) return;
    state.catalog = null;
    $('catalog-status').className = 'notice error';
    $('catalog-status').textContent = `${error.message}\nEntries are never shortened to fit. If a complete entry exceeds the budget, increase the budget and restart enumeration.`;
  }
}

function rawReport(title, report) {
  const details = element('details', 'raw-report');
  details.append(element('summary', '', title));
  let populated = false;
  details.addEventListener('toggle', () => { if (details.open && !populated) { details.append(element('pre', '', JSON.stringify(report, null, 2))); populated = true; } });
  return details;
}
function table(headers, rows) {
  const wrap = element('div', 'report-table-wrap');
  const node = element('table', 'report-table');
  const head = element('thead'); const tr = element('tr');
  for (const header of headers) { const th = element('th', '', header); th.scope = 'col'; tr.append(th); }
  head.append(tr); node.append(head);
  const body = element('tbody');
  for (const values of rows) { const row = element('tr'); for (const value of values) row.append(element('td', '', String(value))); body.append(row); }
  node.append(body); wrap.append(node); return wrap;
}
function chart(entries) {
  const box = element('div', 'chart');
  const max = Math.max(...entries.map((entry) => entry[1] || 0), 1);
  for (const [label, value] of entries) {
    const row = element('div', 'chart-row'); const title = element('div');
    title.append(element('span', '', label), element('strong', '', `${number(value)} tokens`));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 500 8'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
    for (const [className, width] of [['chart-track', 500], ['chart-fill', Number.isFinite(value) ? Math.max(0, value / max * 500) : 0]]) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); rect.setAttribute('class', className); rect.setAttribute('width', String(width)); rect.setAttribute('height', '8'); rect.setAttribute('rx', '3'); svg.append(rect);
    }
    row.append(title, svg); box.append(row);
  }
  return box;
}
function renderScope(scope, target) {
  target.replaceChildren();
  const grid = element('div', 'experiment-grid');
  const comparison = element('section', 'report-panel');
  comparison.append(element('h3', '', 'Serialized payload comparison'), element('p', '', `${number(scope.occurrences)} readable SKILL.md occurrences · ${number(scope.uniqueContents)} unique source hashes`));
  comparison.append(chart([['Raw all — every source skill', scope.rawAllTokens], ['Exact dedup — identical bytes grouped', scope.exactDedupTokens], ['C + S — median, known target', scope.deliveredOnceTokens?.median], ['K + H + S — compact, known target', scope.compactDeliveredOnceTokens?.median], ['2K + H + S — compact replay', scope.compactCatalogReplayTokens?.median]]));
  comparison.append(element('p', '', `C = complete catalog (${number(scope.catalogTokens)} tokens), K = complete compact catalog (${number(scope.compactCatalogTokens)} tokens), H = resolver metadata; S = complete target SKILL.md. Counts use the exact messages defined by the protocol. End-to-end API usage is unmeasured.`));
  const contexts = element('section', 'report-panel');
  contexts.append(element('h3', '', 'Context budget scenarios'), element('p', '', 'Payload sizes follow the reported assumptions. Overflow is reported explicitly; skills are never dropped to make a scenario fit.'));
  for (const context of scope.context || []) {
    const card = element('div', 'context-card'); card.append(element('strong', '', `${number(context.contextTokens)} token context`));
    card.append(element('p', '', `Reserved ${number(context.reservedTokens)} tokens · payload budget ${number(context.payloadBudget)}`));
    const data = element('div', 'context-grid');
    for (const [label, status] of [['Raw all', context.status], ['Exact dedup', context.exactDedup?.status], ['Complete catalog', context.catalog?.status], ['Compact catalog', context.compactCatalog?.status]]) data.append(element('span', '', label), element('span', status === 'FITS_PAYLOAD_BUDGET' ? 'fits' : 'overflows', status === 'FITS_PAYLOAD_BUDGET' ? 'FITS' : status === 'CONTEXT_OVERFLOW' ? 'OVERFLOW' : '—'));
    data.append(element('span', '', 'C+S targets fitting'), element('span', '', `${number(context.oracleResidentFitCount)} / ${number(scope.occurrences)}`));
    data.append(element('span', '', 'K+H+S targets fitting'), element('span', '', `${number(context.compactOracleResidentFitCount)} / ${number(scope.occurrences)}`));
    card.append(data); contexts.append(card);
  }
  grid.append(comparison, contexts); target.append(grid);
}
function renderReports(reports) {
  const host = $('report-content'); host.replaceChildren();
  host.append(element('div', 'notice', 'OFFLINE ORACLE PAYLOAD BENCHMARK · Targets are supplied in advance to measure data size. AI selection accuracy, task success, and actual API usage remain unmeasured. Imported scripts are inert.'));
  const benchmark = reports.benchmark;
  if (benchmark?.scopes?.length) {
    const header = element('section', 'report-panel');
    header.append(element('h3', '', 'Measured corpus'), element('p', '', `${number(benchmark.corpus?.listedSkills)} listed · ${number(benchmark.corpus?.readableSkills)} readable targets · ${number(benchmark.corpus?.excluded?.length || 0)} explicit exclusions · tokenizer ${benchmark.tokenizer?.name || 'unknown'}`));
    header.append(element('p', 'mono', `${benchmark.protocol || 'unknown protocol'} · generated ${benchmark.generatedAt || 'unknown'}`));
    if (benchmark.summaryOnly) header.append(element('p', 'notice', `Showing aggregate results. Every target is retained in ${benchmark.file} (${number(benchmark.bytes)} bytes)`));
    const label = element('label', '', 'Experiment scope'); label.htmlFor = 'experiment-scope';
    const select = element('select'); select.id = 'experiment-scope';
    for (const scope of benchmark.scopes) { const option = element('option', '', scope.scope === 'ALL' ? 'ALL — every repository in the benchmark' : scope.scope); option.value = scope.scope; select.append(option); }
    header.append(label, select); host.append(header);
    const detail = element('div'); host.append(detail); renderScope(benchmark.scopes[0], detail);
    select.addEventListener('change', () => renderScope(benchmark.scopes.find((scope) => scope.scope === select.value), detail));
    const summary = element('section', 'report-panel'); summary.append(element('h3', '', 'All scopes, without hidden rows'));
    summary.append(table(['Scope', 'Targets', 'Raw all', 'Exact dedup', 'Catalog', 'Median C+S', 'Median 2C+S'], benchmark.scopes.map((scope) => [scope.scope, number(scope.occurrences), number(scope.rawAllTokens), number(scope.exactDedupTokens), number(scope.catalogTokens), number(scope.deliveredOnceTokens?.median), number(scope.catalogReplayTokens?.median)])));
    summary.append(element('p', '', 'Unit: tokens. Global and repository scopes overlap and are not independent samples. Supporting files remain in the store and are excluded from every arm of this SKILL.md-only comparison.'));
    summary.append(rawReport(benchmark.summaryOnly ? 'View benchmark summary and limitations' : 'View full benchmark JSON, all targets, and limitations', benchmark)); host.append(summary);
  } else {
    const pending = element('div', 'report-empty');
    pending.append(element('h3', '', benchmark?.status === 'available_on_disk' ? 'Large report available on disk' : 'No benchmark results in this workspace'), element('p', '', benchmark?.status === 'available_on_disk' ? `${benchmark.file} · ${number(benchmark.bytes)} bytes. Large detail reports remain available on disk.` : 'Run the benchmark after import to measure the actual snapshot. Results remain pending until a real run is available.'), element('code', '', 'npm run benchmark -- --db data/skillgraph.sqlite --out reports'));
    host.append(pending);
  }
  for (const name of ['import', 'gitskills-import']) {
    const report = reports[name];
    const panel = element('section', 'report-panel');
    panel.append(element('h3', '', name === 'import' ? 'Repository import ledger' : 'Additional corpus import ledger'));
    if (report?.repositories?.length) {
      panel.append(element('p', '', report.scope || 'Scope: the declared repository snapshots. Coverage of all GitHub skills is not claimed.'));
      panel.append(table(['Repository', 'Commit', 'Status', 'Tree', 'Acquired skills', 'Imported files', 'Failures'], report.repositories.map((repo) => [repo.repository, repo.commit || '—', repo.status, repo.treeVerification || '—', number(repo.acquiredSkills?.length), number(repo.importedPaths?.length), number(repo.failures?.length)])));
      for (const repo of report.repositories) {
        if (repo.failures?.length || repo.rejectedEntries?.length || repo.missingPaths?.length) {
          const details = element('details', 'raw-report'); details.append(element('summary', '', `${repo.repository}: errors, missing files, and excluded entries`), element('pre', '', JSON.stringify({ failures: repo.failures, missingPaths: repo.missingPaths, rejectedEntries: repo.rejectedEntries, unverifiedPaths: repo.unverifiedPaths }, null, 2))); panel.append(details);
        }
      }
    } else if (report?.sourceCounts) {
      panel.append(element('p', '', `${report.status || 'unknown'} · ${report.datasetRevision || 'snapshot unknown'} · Scope: the declared GitSkills sample. Coverage of all GitHub skills is not claimed.`));
      const counts = report.sourceCounts;
      panel.append(table(['Measure', 'Count'], [
        ['Source artifact occurrences', number(counts.artifacts)],
        ['Distinct source contents', number(counts.distinctContents)],
        ['Supplied sibling records', number(counts.siblings?.rows)],
        ['Sibling files described', number(counts.siblings?.files)],
        ['Sibling text supplied', number(counts.siblings?.texts)],
        ['Imported verified artifacts', number(report.importedArtifacts)],
        ['Repaired from canonical Git blobs', number(report.repairedArtifactRows?.length)],
        ['Repaired sibling files', number(report.repairedSiblingRows?.length)],
        ['Unavailable artifact text', number(report.unavailableArtifactRows)],
        ['Imported sibling text rows', number(report.importedSiblingRows)],
        ['Unavailable sibling rows', number(report.unavailableSiblingRows)],
        ['Sibling directories inventoried', number(report.siblingDirectories)],
        ['Integrity or import failures', number(report.failedRows)],
      ]));
      if (report.coverage) panel.append(element('p', '', `Coverage · artifacts complete: ${report.coverage.artifactContentsComplete ? 'yes' : 'no'} · sibling contents complete: ${report.coverage.siblingContentsComplete ? 'yes' : 'no'} · upstream commits available: ${report.coverage.upstreamRepositoryCommitsAvailable ? 'yes' : 'no'}`));
      if (report.integrityFailures?.length || report.repairedArtifactRows?.length || report.repairedSiblingRows?.length) {
        const details = element('details', 'raw-report');
        details.append(element('summary', '', 'Source hash repairs and integrity failures'));
        details.append(element('pre', '', JSON.stringify({ repairedArtifactRows: report.repairedArtifactRows, repairedSiblingRows: report.repairedSiblingRows, integrityFailures: report.integrityFailures }, null, 2)));
        panel.append(details);
      }
    } else panel.append(element('p', '', report?.status === 'available_on_disk' ? `Report available at ${report.file} (${number(report.bytes)} bytes)` : 'This report is unavailable. File counts alone cannot establish acquisition completeness.'));
    if (report && report.status !== 'not_run') panel.append(rawReport(`View complete ${name}.json`, report));
    host.append(panel);
  }
}
async function loadReports() {
  $('report-content').replaceChildren(element('div', 'loading', 'Loading workspace reports…'));
  $('refresh-reports').disabled = true;
  try { state.reports = await api('/api/reports'); renderReports(state.reports); }
  catch (error) { $('report-content').replaceChildren(empty('Reports unavailable', error.message)); }
  finally { $('refresh-reports').disabled = false; }
}

$('explore-tab').addEventListener('click', () => setTab('explore'));
$('experiments-tab').addEventListener('click', () => setTab('experiments'));
$('refresh-reports').addEventListener('click', loadReports);
$('repository').addEventListener('change', () => { state.repository = $('repository').value; state.catalog = null; state.catalogHash = null; state.history = []; loadSkills(0, true); });
$('list-prev').addEventListener('click', () => loadSkills(Math.max(0, state.offset - state.pageSize)));
$('list-next').addEventListener('click', () => { if (state.nextOffset !== null) loadSkills(state.nextOffset); });
$('list-pagination').addEventListener('submit', (event) => { event.preventDefault(); const page = Number($('list-page').value); const max = Math.max(1, Math.ceil(state.total / state.pageSize)); if (Number.isSafeInteger(page) && page >= 1 && page <= max) loadSkills((page - 1) * state.pageSize); else toast(`Page must be between 1–${max}`); });
$('source-prev').addEventListener('click', () => { if (state.lines) loadLines(Math.max(1, state.lines.startLine - 200)); });
$('source-next').addEventListener('click', () => { if (state.lines) loadLines(state.lines.endLine + 1); });
$('source-navigation').addEventListener('submit', (event) => { event.preventDefault(); loadLines(Number($('jump-line').value)); });
$('source-back').addEventListener('click', async () => { const previous = state.history.pop(); if (previous) { await openFile(previous.id, false); if (previous.start !== 1 && state.file?.id === previous.id) loadLines(previous.start); } });
$('copy-lines').addEventListener('click', () => { if (state.lines) copy(state.lines.text); });
$('open-catalog').addEventListener('click', () => { $('catalog-dialog').showModal(); loadCatalog(true); });
$('close-catalog').addEventListener('click', () => $('catalog-dialog').close());
$('catalog-options').addEventListener('submit', (event) => { event.preventDefault(); loadCatalog(true); });
$('catalog-prev').addEventListener('click', () => loadCatalog(false, state.catalogIndex - 1));
$('catalog-next').addEventListener('click', () => loadCatalog(false, state.catalogIndex + 1));
$('copy-catalog').addEventListener('click', () => { if (state.catalog) copy(state.catalog.text); });

async function initialize() {
  try { await loadStats(); await loadSkills(0, true); }
  catch (error) { showError($('global-error'), error); $('skill-list').replaceChildren(empty('Workspace connection failed', 'Check that the local server is running, then reload.')); }
}
initialize();
