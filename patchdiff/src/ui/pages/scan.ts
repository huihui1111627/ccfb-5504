// Page 5: Rule scanner — edit YARA-subset rules, run them against a binary in
// the worker, and present hits with offsets and matched byte content.
import { el, hex, toast } from '../dom';
import { store } from '../store';
import { scanFile } from '../worker-client';
import { DEFAULT_RULES } from '../default-rules';
import type { ScanHit, ScanRule } from '../../core/types';

export function renderScan(view: HTMLElement): void {
  view.innerHTML = '';
  const entries = [...store.binaries.values()];
  view.append(
    el('div', { class: 'page-head' }, el('h2', {}, 'Rule Scanner'),
      el('p', {}, 'YARA-subset engine: text/hex strings, wildcards, jumps, nocase/wide, quantifiers, count/offset refs and boolean conditions.')),
  );

  if (!entries.length) {
    view.append(el('div', { class: 'card' }, el('p', {}, 'Import a binary to scan.')));
    return;
  }

  const selectedId = sessionStorage.getItem('patchdiff.selected') ?? entries[0].binary.id;
  const sel = el('select', {}) as HTMLSelectElement;
  for (const { binary } of entries) sel.append(el('option', { value: binary.id }, binary.fileName));
  sel.value = store.binaries.has(selectedId) ? selectedId : entries[0].binary.id;

  const rules: ScanRule[] = store.rules.length ? store.rules : DEFAULT_RULES.map((r) => ({ ...r }));
  const editor = el('textarea', { rows: '16', spellcheck: 'false' }) as HTMLTextAreaElement;
  editor.value = rules.map((r) => r.source).join('\n\n');

  const resultsHost = el('div', { class: 'card' });
  const runBtn = el('button', {}, 'Scan binary');
  const resetBtn = el('button', { class: 'secondary' }, 'Reset to built-in rules');

  resetBtn.addEventListener('click', () => {
    editor.value = DEFAULT_RULES.map((r) => r.source).join('\n\n');
  });

  runBtn.addEventListener('click', () => run());

  async function run(): Promise<void> {
    const entry = store.binaries.get(sel.value)!;
    let parsed: ScanRule[];
    try {
      // Persist the raw sources under stable identifiers for the worker.
      parsed = editor.value.split(/\n(?=rule\s)/).filter((s) => s.trim()).map((source, i) => ({ identifier: `rule-${i}`, source }));
      store.setRules(parsed);
    } catch (e) {
      toast(`Rule error: ${(e as Error).message}`, true);
      return;
    }
    runBtn.setAttribute('disabled', '');
    try {
      const hits = await scanFile(entry.binary.fileName, entry.bytes, entry.binary.id, parsed);
      renderHits(hits);
      toast(`Scan produced ${hits.length} hit${hits.length === 1 ? '' : 's'}`);
    } catch (e) {
      toast(`Scan failed: ${(e as Error).message}`, true);
    } finally {
      runBtn.removeAttribute('disabled');
    }
  }

  function renderHits(hits: ScanHit[]): void {
    resultsHost.innerHTML = '';
    resultsHost.append(el('h3', {}, `Hits (${hits.length})`));
    if (!hits.length) {
      resultsHost.append(el('p', { class: 'muted' }, 'No matches.'));
      return;
    }
    const table = el('table', {});
    table.append(el('thead', {}, el('tr', {}, ...['Rule', 'Offset', 'Matched data', 'Strings'].map((h) => el('th', {}, h)))));
    const tb = el('tbody', {});
    for (const hit of hits) {
      tb.append(el('tr', {},
        el('td', { class: 'mono' }, hit.rule),
        el('td', { class: 'addr' }, hex(hit.addr)),
        el('td', { class: 'mono muted scroll-x' }, hit.matchedData),
        el('td', { class: 'mono' }, hit.strings.join(', ')),
      ));
    }
    table.append(tb);
    resultsHost.append(table);
  }

  view.append(
    el('div', { class: 'card' },
      el('div', { class: 'field' }, el('label', {}, 'Target binary'), sel),
      el('div', { class: 'field' }, el('label', {}, 'Rules (YARA subset)'), editor),
      el('div', { class: 'toolbar' }, runBtn, resetBtn),
    ),
    resultsHost,
  );
}
