// Page 2: Disassembly — sections, symbols, imports, strings with cross-reference
// navigation and inline rename/comment. The function list drives the CFG page.
import { el, hex, toast, navigate } from '../dom';
import { store } from '../store';
import type { AnalyzedBinary, Function_, Instruction, Xref } from '../../core/types';

type Tab = 'functions' | 'sections' | 'symbols' | 'imports' | 'strings' | 'xrefs';

export function renderDisasm(view: HTMLElement): void {
  view.innerHTML = '';
  const entries = [...store.binaries.values()];
  if (!entries.length) {
    view.append(el('div', { class: 'card' }, el('p', {}, 'No binary selected. Import one in the '),
      el('button', { class: 'secondary' }, 'Library')));
    view.querySelector('button')!.addEventListener('click', () => navigate('library'));
    return;
  }

  const initialId = sessionStorage.getItem('patchdiff.selected') ?? entries[0].binary.id;
  let selectedId = store.binaries.has(initialId) ? initialId : entries[0].binary.id;
  let tab: Tab = 'functions';
  let activeFnAddr: number | null = null;

  const head = el('div', { class: 'page-head' }, el('h2', {}, 'Disassembly'));
  const selector = el('select', {}) as HTMLSelectElement;
  for (const { binary } of entries) selector.append(el('option', { value: binary.id }, binary.fileName));
  selector.value = selectedId;
  selector.addEventListener('change', () => { selectedId = selector.value; sessionStorage.setItem('patchdiff.selected', selectedId); activeFnAddr = null; render(); });

  const tabBar = el('div', { class: 'toolbar' });
  const tabs: Array<[Tab, string]> = [
    ['functions', 'Functions'], ['sections', 'Sections'], ['symbols', 'Symbols'],
    ['imports', 'Imports'], ['strings', 'Strings'], ['xrefs', 'Xrefs'],
  ];
  const content = el('div', {});
  const disasmHost = el('div', { class: 'card' });

  function current(): AnalyzedBinary {
    return store.binaries.get(selectedId)!.binary;
  }

  function render(): void {
    const bin = current();
    tabBar.innerHTML = '';
    for (const [id, label] of tabs) {
      const b = el('button', { class: id === tab ? '' : 'secondary' }, `${label}`);
      b.addEventListener('click', () => { tab = id; render(); });
      tabBar.append(b);
    }
    content.innerHTML = '';
    renderTab(bin);
    renderDisasm(bin);
  }

  function renderTab(bin: AnalyzedBinary): void {
    const card = el('div', { class: 'card', style: 'max-height:340px;overflow:auto' });
    if (tab === 'functions') {
      const table = el('table', {});
      table.append(el('thead', {}, el('tr', {}, ...['Address', 'Name', 'Size', 'Blocks', 'Recovered'].map((h) => el('th', {}, h)))));
      const tb = el('tbody', {});
      for (const fn of bin.functions) {
        const tr = el('tr', { class: 'clickable' });
        tr.append(
          el('td', { class: 'addr' }, hex(fn.addr)),
          el('td', { class: 'mono' }, fn.name),
          el('td', {}, String(fn.size)),
          el('td', {}, String(fn.blocks.length)),
          el('td', {}, fn.recovered ? el('span', { class: 'tag renamed' }, 'recovered') : el('span', { class: 'tag matched' }, 'symbol')),
        );
        tr.addEventListener('click', () => { activeFnAddr = fn.addr; renderDisasm(bin); scrollToFn(fn.addr); });
        tb.append(tr);
      }
      table.append(tb);
      card.append(table);
    } else if (tab === 'sections') {
      const table = el('table', {});
      table.append(el('thead', {}, el('tr', {}, ...['Name', 'Type', 'Addr', 'Size', 'Flags'].map((h) => el('th', {}, h)))));
      const tb = el('tbody', {});
      for (const s of bin.sections) {
        tb.append(el('tr', {},
          el('td', { class: 'mono' }, s.name),
          el('td', { class: 'mono' }, String(s.type)),
          el('td', { class: 'addr' }, hex(s.addr)),
          el('td', {}, String(s.size)),
          el('td', { class: 'muted mono' }, flags(s.flags)),
        ));
      }
      table.append(tb);
      card.append(table);
    } else if (tab === 'symbols') {
      card.append(symbolTable(bin));
    } else if (tab === 'imports') {
      if (!bin.imports.length) card.append(el('p', { class: 'muted' }, 'No imported symbols (freestanding object).'));
      else {
        const ul = el('table', {});
        ul.append(el('thead', {}, el('tr', {}, ...['Name', 'Type', 'Section'].map((h) => el('th', {}, h)))));
        const tb = el('tbody', {});
        for (const s of bin.imports) tb.append(el('tr', {}, el('td', { class: 'mono' }, s.name), el('td', {}, s.type), el('td', {}, s.sectionName)));
        ul.append(tb);
        card.append(ul);
      }
    } else if (tab === 'strings') {
      const table = el('table', {});
      table.append(el('thead', {}, el('tr', {}, ...['Address', 'Section', 'String'].map((h) => el('th', {}, h)))));
      const tb = el('tbody', {});
      for (const s of bin.strings) {
        const tr = el('tr', { class: 'clickable' });
        tr.append(el('td', { class: 'addr' }, hex(s.addr)), el('td', { class: 'muted' }, s.sectionName), el('td', { class: 'mono' }, JSON.stringify(s.value)));
        const xrefs = bin.xrefs.get(s.addr);
        if (xrefs?.length) tr.addEventListener('click', () => { activeFnAddr = xrefs[0].to; renderDisasm(bin); scrollToFn(xrefs[0].to); });
        tb.append(tr);
      }
      table.append(tb);
      card.append(table);
    } else if (tab === 'xrefs') {
      const list = el('div', { class: 'xref-list' });
      let count = 0;
      for (const [to, refs] of bin.xrefs) {
        for (const r of refs) {
          count++;
          const item = el('div', { class: 'xref-item' }, `${xrefLabel(r.type)} 0x${r.from.toString(16)} → 0x${to.toString(16)} (in ${fnName(bin, r.to)})`);
          item.addEventListener('click', () => { activeFnAddr = r.to; renderDisasm(bin); scrollToFn(r.to); });
          list.append(item);
        }
      }
      card.append(count ? list : el('p', { class: 'muted' }, 'No cross references.'));
    }
    content.append(card);
  }

  function renderDisasm(bin: AnalyzedBinary): void {
    disasmHost.innerHTML = '';
    const fns = activeFnAddr != null ? bin.functions.filter((f) => f.addr === activeFnAddr) : bin.functions;
    const toolbar = el('div', { class: 'toolbar' },
      el('strong', {}, activeFnAddr != null ? `Function ${fnName(bin, activeFnAddr)}` : 'All functions'),
    );
    if (activeFnAddr != null) {
      const cfgBtn = el('button', { class: 'secondary' }, 'View CFG');
      cfgBtn.addEventListener('click', () => { sessionStorage.setItem('patchdiff.fn', String(activeFnAddr)); navigate('cfg'); });
      const allBtn = el('button', { class: 'secondary' }, 'Show all');
      allBtn.addEventListener('click', () => { activeFnAddr = null; renderDisasm(bin); });
      toolbar.append(cfgBtn, allBtn);
    }
    const body = el('div', { class: 'disasm scroll-x' });
    for (const fn of fns) body.append(renderFn(bin, fn));
    disasmHost.append(toolbar, body);
  }

  function renderFn(bin: AnalyzedBinary, fn: Function_): HTMLElement {
    const wrap = el('div', { 'data-fn': String(fn.addr), style: 'margin-bottom:18px' });
    const head2 = el('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:6px' });
    const nameEl = el('span', { class: 'mono', style: 'font-weight:600;color:var(--accent)' }, fn.name);
    const rename = el('button', { class: 'secondary', style: 'padding:3px 9px;font-size:11px' }, 'rename');
    rename.addEventListener('click', () => {
      const next = window.prompt('New name', fn.name);
      if (next) { store.rename(bin.id, fn.addr, next); toast('Renamed (saved)'); render(); }
    });
    head2.append(el('span', { class: 'addr' }, hex(fn.addr)), nameEl, el('span', { class: 'muted' }, `; ${fn.insts.length} insns, ${fn.blocks.length} blocks`), rename);
    wrap.append(head2);
    for (const inst of fn.insts) wrap.append(renderInst(bin, inst));
    return wrap;
  }

  function renderInst(bin: AnalyzedBinary, inst: Instruction): HTMLElement {
    const hexBytes = Array.from(inst.bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const row = el('div', { class: 'inst', 'data-addr': String(inst.addr) });
    const refs = bin.xrefs.get(inst.addr);
    row.append(
      el('span', { class: 'addr' }, hex(inst.addr)),
      el('span', { class: 'bytes' }, hexBytes),
      el('span', {}, el('span', { class: 'mn' }, inst.text),
        inst.comment ? el('span', { class: 'comment', style: 'margin-left:12px' }, `; ${inst.comment}`) : '',
        refs?.length ? el('span', { class: 'muted', style: 'margin-left:10px;font-size:11px' }, `[${refs.length} xref]`) : ''),
    );
    if (inst.target !== undefined) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        const targetFn = bin.functions.find((f) => inst.target! >= f.addr && inst.target! < f.addr + f.size);
        if (targetFn) { activeFnAddr = targetFn.addr; renderDisasm(bin); scrollToFn(targetFn.addr); }
      });
    }
    return row;
  }

  function scrollToFn(addr: number): void {
    requestAnimationFrame(() => disasmHost.querySelector(`[data-fn="${addr}"]`)?.scrollIntoView({ block: 'start' }));
  }

  view.append(head, el('div', { class: 'toolbar' }, el('span', { class: 'muted' }, 'Binary:'), selector), tabBar, content, disasmHost);
  render();
}

function flags(f: number): string {
  const names: Array<[number, string]> = [[1, 'W'], [2, 'A'], [4, 'X']];
  return names.filter(([bit]) => f & bit).map(([, n]) => n).join(' ');
}

function fnName(bin: AnalyzedBinary, addr: number): string {
  return bin.functions.find((f) => addr >= f.addr && addr < f.addr + f.size)?.name ?? `sub_${addr.toString(16)}`;
}

function xrefLabel(t: Xref['type']): string {
  return { call: 'CALL', jump: 'JUMP', data: 'DATA', pointer: 'PTR' }[t];
}

function symbolTable(bin: AnalyzedBinary): HTMLElement {
  const table = el('table', {});
  table.append(el('thead', {}, el('tr', {}, ...['Value', 'Size', 'Type', 'Bind', 'Section', 'Name'].map((h) => el('th', {}, h)))));
  const tb = el('tbody', {});
  for (const s of bin.symbols) {
    tb.append(el('tr', {},
      el('td', { class: 'addr' }, hex(s.value)), el('td', {}, String(s.size)),
      el('td', {}, s.type), el('td', {}, s.bind), el('td', { class: 'muted' }, s.sectionName), el('td', { class: 'mono' }, s.name || '—'),
    ));
  }
  table.append(tb);
  return table;
}
