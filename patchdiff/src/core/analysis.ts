// Analysis pipeline: disassembly, function-boundary recovery, CFG construction,
// cross references and matcher feature extraction.
//
// Address model: ET_REL (.o) uses section-relative addresses as they appear in
// the ELF (all section bases start near 0), which keeps relocations and symbol
// values mutually consistent. ET_EXEC/ET_DYN use virtual addresses directly.

import { parseElf, readCStr, type ParsedElf } from './elf';
import { disassembleRange } from './x64/decoder';
import { disassembleA64Range } from './aarch64/decoder';
import { ELF_CONST } from './elf';
import type {
  AnalyzedBinary, Arch, BasicBlock, Bytes, FuncFeatures, Function_, Instruction,
  Relocation, Section, Symbol, Xref, XrefType,
} from './types';

const FNV_OFFSET = 0x811c9dc5;

function fnv1a(s: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Rolling hash used for the fuzzy (ssdeep-style) feature string. */
function fuzzyHash(tokens: string[]): string {
  if (tokens.length === 0) return '';
  const rolling = (bucketCount: number): string => {
    let h1 = FNV_OFFSET;
    let rh = 0;
    const buckets: number[] = [];
    tokens.forEach((t, i) => {
      h1 = Math.imul(h1 ^ fnv1a(t), 0x01000193);
      rh = rh * 7 + t.length + i;
      if (rh % bucketCount === bucketCount - 1) {
        buckets.push(h1 & 0x3f);
        h1 = FNV_OFFSET;
      }
    });
    buckets.push(h1 & 0x3f);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    return buckets.map((b) => alphabet[b]).join('');
  };
  return `${rolling(8)}:${rolling(32)}`;
}

interface ExecSection {
  section: Section;
  insts: Instruction[];
  /** address -> instruction index */
  instAt: Map<number, Instruction>;
}

export class Analysis {
  elf: ParsedElf;
  arch: Arch;
  exec: ExecSection[] = [];
  /** reloc keyed by instruction/field address */
  relocAt = new Map<number, Relocation>();
  /** key: `${sectionName}:${value}` — section-relative values repeat across sections. */
  funcSymbols = new Map<string, Symbol>();
  symbolsByAddr = new Map<number, Symbol>();
  stringAt = new Map<number, string>();

  constructor(public bytes: Bytes) {
    this.elf = parseElf(bytes);
    this.arch = this.elf.header.arch;
  }

  run(): AnalyzedBinary {
    this.indexRelocs();
    this.indexSymbols();
    this.indexStrings();
    this.disassembleSections();
    this.applyRelocTargets();
    const functions = this.recoverFunctions();
    const cfged = functions.map((f) => this.buildCfg(f));
    const xrefs = this.buildXrefs(cfged);
    const withFeatures = cfged.map((f) => ({ ...f, features: this.extractFeatures(f) }));
    const funcIndex = new Map<number, Function_>();
    const nameIndex = new Map<string, number>();
    for (const f of withFeatures) {
      funcIndex.set(f.addr, f);
      nameIndex.set(f.name, f.addr);
    }
    const { symbols, imports, exports, sections, strings, relocations, header, buildId } = this.elf;
    return {
      id: '',
      fileName: '',
      arch: this.arch,
      is64bit: header.is64bit,
      littleEndian: header.littleEndian,
      entryPoint: header.entry,
      type: header.typeName,
      sections,
      symbols,
      imports,
      exports,
      strings,
      relocations,
      functions: withFeatures,
      funcIndex,
      xrefs,
      nameIndex,
      fileBytes: this.bytes,
      buildId,
    };
  }

  private indexRelocs(): void {
    for (const r of this.elf.relocations) this.relocAt.set(r.addr, r);
  }

  private indexSymbols(): void {
    for (const s of this.elf.symbols) {
      if (!s.name) continue;
      if (!this.symbolsByAddr.has(s.value) || s.type === 'function') this.symbolsByAddr.set(s.value, s);
      if (s.type === 'function' && s.sectionIndex !== 0) {
        this.funcSymbols.set(`${s.sectionName}:${s.value}`, s);
      }
    }
  }

  private indexStrings(): void {
    for (const st of this.elf.strings) this.stringAt.set(st.addr, st.value);
  }

  private disassembleSections(): void {
    for (const section of this.elf.sections) {
      if (!(section.flags & ELF_CONST.SHF_EXECINSTR)) continue;
      if (section.type === 8 /* SHT_NOBITS */ || section.size === 0) continue;
      const insts = this.arch === 'x86_64'
        ? disassembleRange(section.data, section.addr, 'att')
        : disassembleA64Range(section.data, section.addr);
      const instAt = new Map<number, Instruction>();
      for (const i of insts) instAt.set(i.addr, i);
      this.exec.push({ section, insts, instAt });
    }
  }

  /** Relocatable objects carry call/data targets as relocations; overlay them. */
  private applyRelocTargets(): void {
    if (this.elf.header.type !== 1 /* ET_REL */) return;
    for (const { insts } of this.exec) {
      for (const inst of insts) {
        // Direct call/jump reloc covers the 4-byte field at the instruction.
        const r = this.relocAt.get(inst.addr);
        if (r && (inst.flow === 'call' || inst.flow === 'direct-jump' || inst.flow === 'conditional-jump')) {
          const target = this.symValueOf(r);
          if (target !== undefined) {
            const sym = this.symbolsByAddr.get(target);
            inst.target = target;
            inst.comment = sym?.name ?? r.symbolName;
          } else if (r.symbolName === '') {
            // Stripped ET_REL: a non-negative addend is the section-relative
            // target of a local call/branch; addend -4 marks an external call.
            if (r.addend >= 0n) inst.target = Number(r.addend);
            else inst.comment = '<external>';
          } else {
            inst.comment = r.symbolName; // imported call
          }
        }
        // RIP-relative data reference with a reloc at the disp field address.
        for (const op of inst.operands) {
          if (op.kind === 'mem' && op.mem?.ripTarget !== undefined) {
            const fieldAddr = inst.addr + inst.bytes.length - 4;
            const dr = this.relocAt.get(fieldAddr);
            if (dr) {
              const val = this.symValueOf(dr);
              if (val !== undefined) op.mem.ripTarget = val;
              else if (dr.symbolName === '' && dr.addend >= 0n) op.mem.ripTarget = Number(dr.addend);
              inst.comment = dr.symbolName;
            }
          }
        }
      }
    }
  }

  private symValueOf(r: Relocation): number | undefined {
    // For ET_REL the referenced symbol's value is the section-relative target.
    const sym = this.elf.symbols.find((s) => s.name === r.symbolName && s.sectionIndex !== 0);
    if (!sym) return undefined;
    return sym.value + Number(r.addend);
  }

  // ---------------- function recovery ----------------

  private funcSymbolAt(secName: string, addr: number): Symbol | undefined {
    return this.funcSymbols.get(`${secName}:${addr}`);
  }

  private recoverFunctions(): Function_[] {
    const out: Function_[] = [];
    for (const es of this.exec) {
      const secName = es.section.name;
      const syms = [...this.funcSymbols.values()]
        .filter((s) => s.sectionName === secName)
        .sort((a, b) => a.value - b.value);
      if (syms.length > 0) {
        // Symbol-driven boundaries (unstripped or partially stripped binary).
        const known = new Set(syms.map((s) => s.value));
        for (const inst of es.insts) {
          if (inst.flow === 'call' && inst.target !== undefined && this.inSection(es, inst.target)) known.add(inst.target);
        }
        for (const sym of syms) {
          const start = sym.value;
          const end = sym.size > 0 ? start + sym.size : this.sweepEnd(es, start, known);
          if (end <= start) continue;
          out.push(this.makeFunction(es, start, end, false, sym));
        }
      } else {
        // Full recovery (stripped). Gather entries from every available signal.
        const starts = this.collectEntries(es);
        const sorted = [...starts].filter((a) => this.inSection(es, a)).sort((a, b) => a - b);
        for (let i = 0; i < sorted.length; i++) {
          const start = sorted[i];
          const end = this.sweepEnd(es, start, new Set(sorted.slice(i + 1)));
          if (end > start) out.push(this.makeFunction(es, start, end, true, undefined));
        }
      }
    }
    return out.sort((a, b) => a.addr - b.addr);
  }

  /** Collect candidate function entries in a stripped executable section. */
  private collectEntries(es: ExecSection): Set<number> {
    const starts = new Set<number>();
    // Signal 0 (strongest for stripped binaries): .eh_frame FDE relocations
    // carry one initial-location entry per function, surviving a normal strip.
    let haveEhFrame = false;
    for (const r of this.elf.relocations) {
      if (r.sectionName === '.rela.eh_frame' && r.addend >= 0n &&
        this.inSection(es, Number(r.addend))) {
        starts.add(Number(r.addend));
        haveEhFrame = true;
      }
    }
    // When eh_frame gives an authoritative entry set, it is more reliable than
    // prologue/terminator heuristics (which over-split); use it alone.
    if (haveEhFrame) return starts;

    // Signal 1: direct call/bl targets (applied relocations on ET_REL, or
    // PC-relative targets on linked binaries).
    for (const inst of es.insts) {
      if (inst.flow === 'call' && inst.target !== undefined && this.inSection(es, inst.target)) {
        starts.add(inst.target);
      }
    }
    // Signal 2: call relocations whose referenced symbol is defined in this
    // section (covers calls whose target could not be computed numerically).
    for (const r of this.elf.relocations) {
      if (r.sectionName !== es.section.name) continue;
      if (this.arch === 'x86_64' ? r.typeName !== 'R_X86_64_PLT32' && r.typeName !== 'R_X86_64_PC32'
        : r.typeName !== 'R_AARCH64_CALL26' && r.typeName !== 'R_AARCH64_JUMP26') continue;
      const sym = this.elf.symbols.find((s) => s.name === r.symbolName && s.sectionName === es.section.name);
      if (sym) starts.add(sym.value + Number(r.addend));
    }
    // Signal 3: classic prologues.
    const prologueLike = new Set<number>();
    this.findPrologues(es, prologueLike);
    prologueLike.forEach((a) => starts.add(a));
    // Signal 4: first instruction of the code section is always an entry.
    if (es.insts.length) starts.add(es.insts[0].addr);
    // Signal 5: boundaries after a terminator. Two cases:
    //  (a) a padding run separates the functions (x86 alignment, A64 sometimes);
    //  (b) optimized A64 packs functions back-to-back with no padding, so a
    //      return followed directly by code is also an entry candidate.
    // For (b) we additionally require the candidate to be a branch target or
    // carry an entry-like first instruction, to avoid splitting at internal rets.
    const branchTargets = new Set<number>();
    for (const inst of es.insts) {
      if ((inst.flow === 'direct-jump' || inst.flow === 'conditional-jump') &&
        inst.target !== undefined && this.inSection(es, inst.target)) {
        branchTargets.add(inst.target);
      }
    }
    for (let i = 0; i < es.insts.length; i++) {
      const prev = es.insts[i - 1];
      if (!prev || (prev.flow !== 'return' && prev.flow !== 'direct-jump')) continue;
      let j = i;
      let sawPadding = false;
      while (j < es.insts.length && this.isPadding(es.insts[j])) {
        sawPadding = true;
        j++;
      }
      if (j >= es.insts.length) continue;
      const candidate = es.insts[j];
      if (sawPadding) {
        starts.add(candidate.addr);
      } else if (this.arch === 'aarch64' && this.looksLikeEntry(candidate)) {
        // Back-to-back A64 functions with no padding: trust only an entry-like
        // instruction (frame setup / stp x29,x30 / sp adjustment), not ordinary
        // branch targets which frequently land mid-function.
        starts.add(candidate.addr);
      }
    }
    return starts;
  }

  /** Entry-like first instruction for optimized functions without frame pointers. */
  private looksLikeEntry(inst: Instruction): boolean {
    if (this.arch === 'x86_64') {
      return inst.mnemonic === 'push' || inst.mnemonic === 'endbr64' ||
        (inst.mnemonic === 'sub' && inst.operands[0]?.reg === 'rsp');
    }
    return inst.mnemonic === 'stp' ||
      (inst.mnemonic === 'sub' && inst.operands[0]?.reg === 'sp') ||
      inst.mnemonic === 'paciasp';
  }

  private inSection(es: ExecSection, addr: number): boolean {
    return addr >= es.section.addr && addr < es.section.addr + es.section.size;
  }

  private makeFunction(es: ExecSection, start: number, end: number, recovered: boolean, sym: Symbol | undefined): Function_ {
    const insts = es.insts.filter((i) => i.addr >= start && i.addr < end);
    const callTargets = [...new Set(insts.filter((i) => i.flow === 'call' && i.target !== undefined).map((i) => i.target!))];
    return {
      name: sym?.name || this.nameFor(start),
      addr: start,
      size: end - start,
      sectionName: es.section.name,
      entry: start,
      blocks: [],
      insts,
      callTargets,
      recovered: recovered || !sym,
      features: emptyFeatures(),
    };
  }

  private nameFor(addr: number): string {
    return this.symbolsByAddr.get(addr)?.name ?? `sub_${addr.toString(16)}`;
  }

  private sectionOf(addr: number): ExecSection | undefined {
    return this.exec.find((e) => this.inSection(e, addr));
  }

  /** Heuristic prologue scan for stripped binaries. */
  private findPrologues(es: ExecSection, out: Set<number>): void {
    const insts = es.insts;
    for (let i = 0; i < insts.length; i++) {
      const inst = insts[i];
      if (this.arch === 'x86_64') {
        // push %rbp; mov %rsp,%rbp — the classic frame setup, O0/O2 common.
        if (inst.mnemonic === 'push' && inst.operands[0]?.reg === 'rbp') {
          const next = insts[i + 1];
          if (next && next.mnemonic === 'mov' && next.operands[1]?.reg === 'rsp' && next.operands[0]?.reg === 'rbp') {
            out.add(inst.addr);
          }
        }
        // endbr64 (CET) on modern toolchains, or int3 padding break then prologue.
        if (inst.mnemonic === 'endbr64') out.add(inst.addr);
      } else {
        // stp x29, x30, [sp, ...]! / stp x29, x30, [sp, #...]
        if (inst.mnemonic === 'stp' && /x29, x30/.test(inst.opStr)) out.add(inst.addr);
        // sub sp, sp, #... as a leaf prologue
        if (inst.mnemonic === 'sub' && inst.operands[0]?.reg === 'sp' && inst.operands[1]?.reg === 'sp') {
          const prev = insts[i - 1];
          if (!prev || prev.flow === 'return' || prev.invalid || this.isPadding(prev)) out.add(inst.addr);
        }
      }
    }
  }

  private isPadding(inst: Instruction): boolean {
    // nopl/nopw/nop and trap padding; A64 spells its NOP as plain "nop".
    return inst.mnemonic === 'nop' || inst.mnemonic === 'nopl' || inst.mnemonic === 'nopw' ||
      inst.mnemonic === '.byte' || inst.mnemonic === 'ud2';
  }

  /** Linear sweep from start until a terminator followed by padding/next start. */
  private sweepEnd(es: ExecSection, start: number, nextStarts: ReadonlySet<number>): number {
    const begin = es.insts.findIndex((i) => i.addr === start);
    if (begin < 0) return start;
    let end = es.section.addr + es.section.size;
    for (let i = begin; i < es.insts.length; i++) {
      const inst = es.insts[i];
      if (inst.addr !== start && nextStarts.has(inst.addr)) {
        end = inst.addr;
        break;
      }
      if (i > begin && (inst.flow === 'return')) {
        // Include the ret; stop if the following slot is padding or a new prologue.
        const after = es.insts[i + 1];
        if (!after || this.isPadding(after) || nextStarts.has(after.addr)) {
          end = inst.addr + inst.bytes.length;
          break;
        }
      }
      if (inst.invalid) {
        end = inst.addr;
        break;
      }
    }
    return end;
  }

  // ---------------- CFG ----------------

  private buildCfg(fn: Function_): Function_ {
    const insts = fn.insts;
    if (insts.length === 0) return { ...fn, blocks: [] };
    const leaders = new Set<number>([fn.entry]);
    const byAddr = new Map(insts.map((i) => [i.addr, i]));
    for (let i = 0; i < insts.length; i++) {
      const inst = insts[i];
      if (inst.target !== undefined && byAddr.has(inst.target) &&
        (inst.flow === 'direct-jump' || inst.flow === 'conditional-jump')) {
        leaders.add(inst.target);
      }
      if ((inst.flow === 'direct-jump' || inst.flow === 'conditional-jump' || inst.flow === 'return') && insts[i + 1]) {
        leaders.add(insts[i + 1].addr);
      }
    }
    const sortedLeaders = [...leaders].sort((a, b) => a - b);
    const blocks: BasicBlock[] = [];
    for (let li = 0; li < sortedLeaders.length; li++) {
      const bStart = sortedLeaders[li];
      const bEnd = li + 1 < sortedLeaders.length ? sortedLeaders[li + 1] : fn.addr + fn.size;
      const bInsts = insts.filter((i) => i.addr >= bStart && i.addr < bEnd);
      if (bInsts.length === 0) continue;
      blocks.push({
        id: `bb_${bStart.toString(16)}`,
        start: bStart,
        end: bEnd,
        insts: bInsts,
        successors: [],
        predecessors: [],
      });
    }
    const blockAt = new Map(blocks.map((b) => [b.start, b]));
    for (let bi = 0; bi < blocks.length; bi++) {
      const b = blocks[bi];
      const last = b.insts[b.insts.length - 1];
      const fall = blocks[bi + 1];
      if ((last.flow === 'direct-jump' || last.flow === 'conditional-jump') && last.target !== undefined) {
        const tb = blockAt.get(last.target);
        if (tb) b.successors.push(tb.start);
      }
      if (last.flow !== 'direct-jump' && last.flow !== 'return' && fall) {
        b.successors.push(fall.start);
      }
      if (last.flow === 'indirect-jump' && fall) b.successors.push(fall.start);
    }
    for (const b of blocks) {
      for (const s of b.successors) blockAt.get(s)?.predecessors.push(b.start);
    }
    return { ...fn, blocks };
  }

  // ---------------- xrefs ----------------

  private buildXrefs(fns: Function_[]): Map<number, Xref[]> {
    const xrefs = new Map<number, Xref[]>();
    const add = (to: number, x: Xref) => {
      const list = xrefs.get(to);
      if (list) list.push(x);
      else xrefs.set(to, [x]);
    };
    const funcOf = (addr: number): number | undefined => {
      let best: Function_ | undefined;
      for (const f of fns) if (addr >= f.addr && addr < f.addr + f.size) best = f;
      return best?.addr;
    };
    for (const f of fns) {
      for (const inst of f.insts) {
        const fromFn = f.addr;
        if (inst.target !== undefined && (inst.flow === 'call' || inst.flow === 'direct-jump' || inst.flow === 'conditional-jump')) {
          const type: XrefType = inst.flow === 'call' ? 'call' : 'jump';
          add(inst.target, { from: inst.addr, to: inst.target, type, funcAddr: fromFn });
        }
        for (const op of inst.operands) {
          if (op.kind === 'mem') {
            const t = op.mem?.ripTarget;
            if (t !== undefined) add(t, { from: inst.addr, to: t, type: 'data', funcAddr: fromFn });
          }
          if (op.kind === 'imm' && this.arch === 'aarch64' && (inst.mnemonic === 'adrp' || inst.mnemonic === 'adr')) {
            const t = Number(op.imm!);
            if (this.stringAt.has(t) || this.symbolsByAddr.has(t)) {
              add(t, { from: inst.addr, to: t, type: 'data', funcAddr: fromFn });
            }
          }
        }
      }
    }
    // Function-pointer tables (init_array) and absolute pointer slots.
    for (const s of this.elf.sections) {
      if (s.name === '.init_array' || s.name === '.fini_array') {
        for (let off = 0; off + 8 <= s.data.length; off += 8) {
          const v = Number(new DataView(s.data.buffer, s.data.byteOffset + off, 8).getBigUint64(0, true));
          if ([...this.funcSymbols.values()].some((sym) => sym.value === v)) {
            add(v, { from: s.addr + off, to: v, type: 'pointer' });
          }
        }
      }
    }
    void funcOf;
    return xrefs;
  }

  // ---------------- features ----------------

  private extractFeatures(fn: Function_): FuncFeatures {
    const mnemonicCounts: Record<string, number> = {};
    const constants = new Set<number>();
    const calleeNames = new Set<string>();
    const stringRefs: number[] = [];
    let numCalls = 0;
    let numBranches = 0;
    let numCond = 0;
    const tokens: string[] = [];

    for (const inst of fn.insts) {
      mnemonicCounts[inst.mnemonic] = (mnemonicCounts[inst.mnemonic] ?? 0) + 1;
      tokens.push(inst.mnemonic);
      if (inst.flow === 'call') {
        numCalls++;
        if (inst.comment) calleeNames.add(inst.comment);
        else if (inst.target !== undefined) {
          const name = this.nameFor(inst.target);
          if (name) calleeNames.add(name);
        }
      }
      if (inst.flow === 'direct-jump' || inst.flow === 'indirect-jump') numBranches++;
      if (inst.flow === 'conditional-jump') {
        numBranches++;
        numCond++;
      }
      for (const op of inst.operands) {
        if (op.kind === 'imm' && inst.flow !== 'call' && inst.flow !== 'direct-jump' && inst.flow !== 'conditional-jump') {
          const v = Number(BigInt.asIntN(32, op.imm!));
          if (Math.abs(v) > 1 && Math.abs(v) < 0x100000) constants.add(v);
        }
        if (op.kind === 'mem' && op.mem?.ripTarget !== undefined) {
          const str = this.stringAt.get(op.mem.ripTarget);
          if (str !== undefined) stringRefs.push(fnv1a(str));
        }
      }
      if (this.arch === 'aarch64' && (inst.mnemonic === 'adrp' || inst.mnemonic === 'adr')) {
        for (const op of inst.operands) {
          if (op.kind === 'imm') {
            const str = this.stringAt.get(Number(op.imm!));
            if (str !== undefined) stringRefs.push(fnv1a(str));
          }
        }
      }
    }
    // callees from reloc comments
    for (const t of fn.callTargets) {
      const n = this.nameFor(t);
      if (n && !n.startsWith('sub_')) calleeNames.add(n);
    }
    const mnemonicHash = fnv1a(tokens.join('|'));
    return {
      mnemonicCounts,
      numInsts: fn.insts.length,
      numBlocks: fn.blocks.length,
      numCalls,
      numBranches,
      numCondBranches: numCond,
      constants: [...constants].sort((a, b) => a - b),
      calleeNames: [...calleeNames].sort(),
      stringRefs: [...new Set(stringRefs)],
      mnemonicHash,
      fuzzyHash: fuzzyHash(tokens),
    };
  }
}

function emptyFeatures(): FuncFeatures {
  return {
    mnemonicCounts: {}, numInsts: 0, numBlocks: 0, numCalls: 0, numBranches: 0,
    numCondBranches: 0, constants: [], calleeNames: [], stringRefs: [], mnemonicHash: 0, fuzzyHash: '',
  };
}

export function analyzeBinary(bytes: Bytes, id: string, fileName: string): AnalyzedBinary {
  const analysis = new Analysis(bytes);
  const result = analysis.run();
  result.id = id;
  result.fileName = fileName;
  return result;
}

export { readCStr };
