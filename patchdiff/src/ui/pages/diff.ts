// Page 4: Patch Diff — pick two binaries, run the worker-backed differ, rank
// changed functions and expand any of them into a block-level side-by-side view.
import { el, toast } from '../dom';
import { store } from '../store';
import { diffFiles } from '../worker-client';
import { downloadText, exportJson, exportMarkdown } from '../report';
import type { FuncDiff } from '../../core/types';

export function renderDiff(view: HTMLElement): void {
  view.innerHTML = '';
  const entries = [...store.binaries.values()];
  view.append(
    el('div', { class: 'page-head' }, el('h2', {}, 'Patch Diff'),
      el('p', {}, 'Function matching works on stripped binaries via mnemonic multiset, CFG shape, constants, callees and string references.')),
  );

  if (entries.length < 2) {
    view.append(el('div', { class: 'card' }, el('p', {}, 'Import at least two binaries (e.g. the original and patched firmware).')));
    return;
  }

  const oldSel = el('select', {}) as HTMLSelectElement;
  const newSel = el('select', {}) as HTMLSelectElement;
  for (const { binary } of entries) {
    oldSel.append(el('option', { value: binary.id }, binary.fileName));
    newSel.append(el('option', { value: binary.id }, binary.fileName));
  }
  // Sensible default: pick a "fw" and a "fw_patched" if present.
  const findBy = (sub: string) => entries.find((e) => e.binary.fileName.includes(sub))?.binary.id;
  if (findBy('fw_patched')) newSel.value = findBy('fw_patched')!;
  if (findBy('fw.')) oldSel.value = findBy('fw.')!;

  const runBtn = el('button', {}, 'Run diff');
  const statsHost = el('div', { class: 'grid grid-3' });
  const listHost = el('div', { class: 'card' });
  const detailHost = el('div', {});

  runBtn.addEventListener('click', () => run());

  view.append(
    el('div', { class: 'card' },
      el('div', { class: 'grid grid-2' },
        el('div', { class: 'field' }, el('label', {}, 'Old (vulnerable)'), oldSel),
        el('div', { class: 'field' }, el('label', {}, 'New (patched)'), newSel),
      ),
      runBtn,
    ),
    statsHost, listHost, detailHost,
  );

  async function run(): Promise<void> {
    const oldEntry = store.binaries.get(oldSel.value)!;
    const newEntry = store.binaries.get(newSel.value)!;
    if (oldEntry === newEntry) { toast('Choose two different binaries', true); return; }
    runBtn.setAttribute('disabled', '');
    try {
      const result = await diffFiles(
        { id: oldEntry.binary.id, fileName: oldEntry.binary.fileName, bytes: oldEntry.bytes },
        { id: newEntry.binary.id, fileName: newEntry.binary.fileName, bytes: newEntry.bytes },
      );
      store.setDiff(result, oldEntry.binary.id, newEntry.binary.id);
      renderStats(result.stats);
      renderList(result.diffs);
      toast(`Diff complete: ${result.stats.modified} modified, ${result.stats.added} added, ${result.stats.removed} removed`);
    } catch (e) {
      toast(`Diff failed: ${(e as Error).message}`, true);
    } finally {
      runBtn.removeAttribute('disabled');
    }
  }

  function renderStats(stats: ReturnType<typeof Object>): void {
    statsHost.innerHTML = '';
    const items: Array<[string, number, string]> = [
      ['Matched', (stats as { matched: number }).matched, 'var(--accent)'],
      ['Modified', (stats as { modified: number }).modified, 'var(--amber)'],
      ['Added / Removed', (stats as { added: number }).added + (stats as { removed: number }).removed, 'var(--green)'],
    ];
    for (const [lbl, num, color] of items) {
      const card = el('div', { class: 'stat' });
      card.append(el('div', { class: 'num', style: `color:${color}` }, String(num)), el('div', { class: 'lbl' }, lbl));
      statsHost.append(card);
    }
  }

  function renderList(diffs: FuncDiff[]): void {
    listHost.innerHTML = '';
    const head = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px' },
      el('h3', { style: 'margin:0' }, 'Changed functions (ranked)'),
      el('div', {},
        mkExportBtn('Export JSON', 'json'),
        el('span', {}, ' '),
        mkExportBtn('Export Markdown', 'md'),
      ),
    );
    const table = el('table', {});
    table.append(el('thead', {}, el('tr', {},
      ...['Old function', 'New function', 'Status', 'Similarity', 'Changes', 'Match reason', ''].map((h) => el('th', {}, h)))));
    const tb = el('tbody', {});
    for (const d of diffs) {
      const tr = el('tr', { class: 'clickable' });
      const simPct = Math.round(d.similarity * 100);
      tr.append(
        el('td', { class: 'mono' }, d.match.oldName ?? '—'),
        el('td', { class: 'mono' }, d.match.newName ?? '—'),
        el('td', {}, el('span', { class: `tag ${tagKind(d)}` }, tagKind(d))),
        el('td', {}, simBar(simPct)),
        el('td', { class: 'mono' }, `+${d.changeSummary.added} -${d.changeSummary.removed} ~${d.changeSummary.modified}`),
        el('td', { class: 'muted' }, d.match.reason),
      );
      tr.addEventListener('click', () => renderDetail(d));
      tb.append(tr);
    }
    table.append(tb);
    listHost.append(head, table);
  }

  function mkExportBtn(label: string, kind: 'json' | 'md'): HTMLButtonElement {
    const b = el('button', { class: 'secondary' }, label);
    b.addEventListener('click', () => {
      const oldEntry = store.binaries.get(oldSel.value)!;
      const newEntry = store.binaries.get(newSel.value)!;
      if (!store.diff) return;
      if (kind === 'json') downloadText('patchdiff-report.json', exportJson(oldEntry.binary, newEntry.binary, store.diff), 'application/json');
      else downloadText('patchdiff-report.md', exportMarkdown(oldEntry.binary, newEntry.binary, store.diff), 'text/markdown');
    });
    return b;
  }

  function renderDetail(d: FuncDiff): void {
    detailHost.innerHTML = '';
    const title = `${d.match.oldName ?? d.match.newName} — block-level changes`;
    const wrap = el('div', { class: 'card' }, el('h3', {}, title));
    for (const block of d.changes) {
      const box = el('div', { style: 'margin-bottom:14px;border:1px solid var(--border);border-radius:8px;overflow:hidden' });
      const head2 = el('div', { style: 'padding:8px 12px;background:var(--panel-2);display:flex;justify-content:space-between' },
        el('strong', { class: `tag ${block.kind}` }, block.kind.toUpperCase()),
        el('span', { class: 'muted mono' }, `similarity ${(block.similarity * 100).toFixed(0)}%`),
      );
      const code = el('div', { class: 'diff-code', style: 'padding:8px 12px' });
      for (const row of block.rows) {
        if (row.kind === 'unchanged') code.append(el('div', { class: 'ctx' }, `  ${row.oldInst?.text ?? ''}`));
        if (row.kind === 'added') code.append(el('div', { class: 'plus' }, `+ ${row.newInst?.text ?? ''}`));
        if (row.kind === 'removed') code.append(el('div', { class: 'minus' }, `- ${row.oldInst?.text ?? ''}`));
        if (row.kind === 'modified') {
          code.append(el('div', { class: 'minus' }, `- ${row.oldInst?.text ?? ''}`));
          code.append(el('div', { class: 'plus' }, `+ ${row.newInst?.text ?? ''}`));
        }
      }
      box.append(head2, code);
      wrap.append(box);
    }
    detailHost.append(wrap);
    wrap.scrollIntoView({ behavior: 'smooth' });
  }
}

function simBar(pct: number): HTMLElement {
  return el('div', {},
    el('div', { class: 'mono muted', style: 'font-size:11px;margin-bottom:3px' }, `${pct}%`),
    el('div', { class: 'similarity-bar', style: 'width:90px' }, el('div', { class: 'similarity-fill', style: `width:${pct}%` })),
  );
}

/** Surface the most useful state: added/removed win; paired functions that
 *  differ show "modified", identical ones keep their match/renamed status. */
function tagKind(d: FuncDiff): string {
  if (d.match.status === 'added' || d.match.status === 'removed') return d.match.status;
  return d.similarity < 1 ? 'modified' : d.match.status;
}
