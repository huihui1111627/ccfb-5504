// Page 1: Sample library — import ELF files, see parsed metadata and open a
// binary in the disassembly or diff page.
import { el, hex, readFileBytes, toast, navigate } from '../dom';
import { store } from '../store';
import { analyzeFile } from '../worker-client';
import type { AnalyzedBinary } from '../../core/types';

export function renderLibrary(view: HTMLElement): void {
  view.innerHTML = '';
  view.append(
    el('div', { class: 'page-head' },
      el('h2', {}, 'Sample Library'),
      el('p', {}, 'Import ELF objects or executables (x86-64 / AArch64). Parsing, function recovery and feature extraction run in a Web Worker.'),
    ),
  );

  const drop = el('div', { class: 'dropzone' },
    el('div', { html: '<strong>Drop ELF files here</strong> or click to browse' }),
    el('div', { class: 'muted', style: 'margin-top:8px;font-size:12px' }, '.o / .elf — multiple files supported'),
  );
  const input = el('input', { type: 'file', multiple: '', accept: '.o,.elf,.so,application/octet-stream' }) as HTMLInputElement;
  input.style.display = 'none';
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    void ingest(e.dataTransfer?.files ?? []);
  });
  input.addEventListener('change', () => void ingest(input.files ?? []));

  const tableHost = el('div', { class: 'card' });
  const refresh = () => {
    tableHost.innerHTML = '';
    const entries = [...store.binaries.values()];
    document.getElementById('binary-count')!.textContent = `${entries.length} binaries`;
    if (!entries.length) {
      tableHost.append(el('p', { class: 'muted' }, 'No binaries imported yet.'));
      return;
    }
    const table = el('table', {});
    table.append(el('thead', {}, el('tr', {},
      ...['File', 'Arch', 'Type', 'Sections', 'Functions', 'Strings', 'Imports', ''].map((h) => el('th', {}, h)),
    )));
    const tbody = el('tbody', {});
    for (const { binary } of entries) {
      const tr = el('tr', { class: 'clickable' });
      tr.append(
        el('td', { class: 'mono' }, binary.fileName),
        el('td', {}, el('span', { class: `badge ${binary.arch === 'x86_64' ? 'x64' : 'a64'}` }, binary.arch)),
        el('td', { class: 'mono' }, binary.type),
        el('td', {}, String(binary.sections.length)),
        el('td', {}, String(binary.functions.length)),
        el('td', {}, String(binary.strings.length)),
        el('td', {}, String(binary.imports.length)),
      );
      const actions = el('td', {});
      const openBtn = el('button', { class: 'secondary' }, 'Disassemble');
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        sessionStorage.setItem('patchdiff.selected', binary.id);
        navigate('disasm');
      });
      const delBtn = el('button', { class: 'danger' }, 'Remove');
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        store.removeBinary(binary.id);
      });
      actions.append(openBtn, el('span', {}, ' '), delBtn);
      tr.append(actions);
      tr.addEventListener('click', () => {
        sessionStorage.setItem('patchdiff.selected', binary.id);
        navigate('disasm');
      });
      tbody.append(tr);
    }
    table.append(tbody);
    tableHost.append(table);
  };

  async function ingest(files: FileList | File[]): Promise<void> {
    for (const file of Array.from(files)) {
      try {
        const bytes = await readFileBytes(file);
        const id = `bin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const binary: AnalyzedBinary = await analyzeFile(file.name, bytes, id);
        store.addBinary(binary, bytes);
        toast(`Imported ${file.name}: ${binary.functions.length} functions`);
      } catch (e) {
        toast(`Failed ${file.name}: ${(e as Error).message}`, true);
      }
    }
    refresh();
  }

  store.subscribe(refresh);
  view.append(el('div', { class: 'card' }, drop, input), tableHost);
  refresh();

  // Offer the bundled sample corpus when present (dev convenience).
  if (store.binaries.size === 0) {
    const hint = el('p', { class: 'muted', style: 'font-size:12px' },
      `Tip: build the bundled corpus with ${el('code', {}, 'bash scripts/build-samples.sh').textContent} and import files from samples/bin/.`);
    view.append(hint);
  }
  void hex;
}
