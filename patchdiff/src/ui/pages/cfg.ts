// Page 3: Control-Flow Graph — renders basic blocks and edges as inline SVG.
// Layout is a simple topological tier layout; edge colors distinguish branch
// targets (solid) from loop back-edges (dashed amber).
import { el, hex, navigate } from '../dom';
import { store } from '../store';
import type { AnalyzedBinary, BasicBlock } from '../../core/types';

const NODE_W = 230;
const NODE_H = 64;
const GAP_X = 60;
const GAP_Y = 48;

export function renderCfg(view: HTMLElement): void {
  view.innerHTML = '';
  const entries = [...store.binaries.values()];
  if (!entries.length) {
    view.append(emptyState());
    return;
  }
  const selectedId = sessionStorage.getItem('patchdiff.selected') ?? entries[0].binary.id;
  const bin = store.binaries.has(selectedId) ? store.binaries.get(selectedId)!.binary : entries[0].binary;

  const fnAddr = sessionStorage.getItem('patchdiff.fn');
  const fn = fnAddr != null
    ? bin.functions.find((f) => f.addr === Number(fnAddr))
    : bin.functions[0];

  view.append(
    el('div', { class: 'page-head' }, el('h2', {}, 'Control-Flow Graph'),
      el('p', {}, 'Basic blocks recovered from branch targets and terminators. Click a node to inspect its instructions.')),
  );

  const selector = el('select', {}) as HTMLSelectElement;
  for (const f of bin.functions) selector.append(el('option', { value: String(f.addr) }, `${f.name} @${hex(f.addr)}`));
  if (fn) selector.value = String(fn.addr);
  selector.addEventListener('change', () => { sessionStorage.setItem('patchdiff.fn', selector.value); renderCfg(view); });

  const host = el('div', { class: 'cfg-canvas card' });
  if (!fn) {
    host.append(el('p', { class: 'muted' }, 'No function available.'));
  } else {
    host.append(buildSvg(bin, fn, host));
  }
  view.append(el('div', { class: 'toolbar' }, el('span', { class: 'muted' }, 'Function:'), selector), host);
}

function buildSvg(bin: AnalyzedBinary, fn: { blocks: BasicBlock[]; entry: number; name: string }, host: HTMLElement): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = '<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#8b949e"/></marker>';
  svg.append(defs);

  // Tier assignment by longest-path depth from entry.
  const indexByStart = new Map<number, number>();
  fn.blocks.forEach((b, i) => indexByStart.set(b.start, i));
  const tier = new Array(fn.blocks.length).fill(0);
  const entryIdx = indexByStart.get(fn.entry) ?? 0;
  const visited = new Set<number>();
  const walk = (idx: number, depth: number) => {
    if (visited.has(idx)) return;
    visited.add(idx);
    tier[idx] = Math.max(tier[idx], depth);
    for (const s of fn.blocks[idx].successors) {
      const ni = indexByStart.get(s);
      if (ni !== undefined) walk(ni, depth + 1);
    }
  };
  walk(entryIdx, 0);

  const tiers = new Map<number, number[]>();
  tier.forEach((t, i) => {
    if (!tiers.has(t)) tiers.set(t, []);
    tiers.get(t)!.push(i);
  });
  const maxTier = Math.max(...tier);
  const positions = new Map<number, { x: number; y: number }>();
  for (let t = 0; t <= maxTier; t++) {
    const nodes = tiers.get(t) ?? [];
    nodes.forEach((nodeIdx, row) => {
      positions.set(nodeIdx, { x: 30 + t * (NODE_W + GAP_X), y: 30 + row * (NODE_H + GAP_Y) });
    });
  }

  // Edges first so nodes render above them.
  fn.blocks.forEach((b, i) => {
    const from = positions.get(i)!;
    for (const succ of b.successors) {
      const j = indexByStart.get(succ)!;
      const to = positions.get(j)!;
      const back = tier[j] <= tier[i];
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const mid = (x1 + x2) / 2;
      path.setAttribute('d', `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
      path.setAttribute('class', `cfg-edge${back ? ' back' : ''}`);
      svg.append(path);
    }
  });

  // Nodes.
  fn.blocks.forEach((b, i) => {
    const p = positions.get(i)!;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', `cfg-node${b.start === fn.entry ? ' entry' : ''}`);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(p.x)); rect.setAttribute('y', String(p.y));
    rect.setAttribute('width', String(NODE_W)); rect.setAttribute('height', String(NODE_H));
    rect.setAttribute('rx', '8');
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = b.insts.map((ins) => ins.text).join('\n');
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(p.x + 10)); label.setAttribute('y', String(p.y + 22));
    label.textContent = `BB${i} @${hex(b.start)}`;
    const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    sub.setAttribute('x', String(p.x + 10)); sub.setAttribute('y', String(p.y + 42));
    sub.setAttribute('fill', '#8b949e');
    const first = b.insts[0];
    sub.textContent = first ? first.text.slice(0, 28) : '';
    g.append(rect, title, label, sub);
    g.style.cursor = 'pointer';
    g.addEventListener('click', () => {
      sessionStorage.setItem('patchdiff.fn', String(fn.blocks[0] && findFnAddr(bin, b.start)));
      sessionStorage.setItem('patchdiff.selected', bin.id);
      navigate('disasm');
    });
    svg.append(g);
  });

  const width = 30 + (maxTier + 1) * (NODE_W + GAP_X);
  const rows = Math.max(...[...tiers.values()].map((n) => n.length));
  svg.setAttribute('viewBox', `0 0 ${width} ${30 + rows * (NODE_H + GAP_Y)}`);
  void host;
  return svg;
}

function findFnAddr(bin: AnalyzedBinary, blockStart: number): number {
  return bin.functions.find((f) => f.blocks.some((b) => b.start === blockStart))?.addr ?? 0;
}

function emptyState(): HTMLElement {
  const card = el('div', { class: 'card' }, el('p', {}, 'Import a binary first.'));
  const btn = el('button', {}, 'Go to library');
  btn.addEventListener('click', () => navigate('library'));
  card.append(btn);
  return card;
}
