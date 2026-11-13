// Shared core type definitions for the patch-diff workbench.

export type Arch = 'x86_64' | 'aarch64';

/** Shared byte-array type compatible with the TS 5.7+ generic Uint8Array. */
export type Bytes = Uint8Array<ArrayBufferLike>;

/** A single decoded instruction, architecture neutral. */
export interface Instruction {
  /** virtual address */
  addr: number;
  /** raw bytes */
  bytes: Bytes;
  /** mnemonic, e.g. "mov" / "str" (no width suffix on x86; width is in operands) */
  mnemonic: string;
  /** rendered operands exactly as formatted (objdump-style), without comments */
  opStr: string;
  /** full rendered text "mnemonic\topStr" */
  text: string;
  /** optional trailing comment such as aarch64 "// =42" or x86 relocation target */
  comment: string;
  /** architecture-specific structured operand info used by analysis */
  operands: Operand[];
  /** control-flow classification */
  flow: FlowType;
  /** branch/call target address when direct, else undefined */
  target?: number;
  /** true when this instruction could not be decoded (data in code, unknown opcode) */
  invalid?: boolean;
}

export type FlowType =
  | 'call'
  | 'direct-jump'
  | 'indirect-jump'
  | 'conditional-jump'
  | 'return'
  | 'syscall'
  | 'normal';

export type OperandKind = 'reg' | 'imm' | 'mem' | 'fp-reg' | 'sysreg';

export interface Operand {
  kind: OperandKind;
  /** register name (reg/fp-reg/sysreg) */
  reg?: string;
  /** immediate value (imm) — sign extended to signed bigint-safe number or BigInt flag */
  imm?: bigint;
  /** memory operand details */
  mem?: {
    base?: string;
    index?: string;
    scale?: number;
    disp?: bigint;
    /** RIP-relative target absolute address, filled by disassembler when possible */
    ripTarget?: number;
    /** access width for memory operands (x86 only) */
    width?: number;
  };
}

/** ELF section header. */
export interface Section {
  name: string;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  link: number;
  info: number;
  addralign: number;
  /** raw content, lazily copied out of the file */
  data: Bytes;
}

export type SymbolType =
  | 'notype'
  | 'object'
  | 'function'
  | 'section'
  | 'file'
  | 'common'
  | 'tls';

export type SymbolBind = 'local' | 'global' | 'weak';

export interface Symbol {
  name: string;
  value: number;
  size: number;
  type: SymbolType;
  bind: SymbolBind;
  sectionIndex: number;
  /** section name resolved from sectionIndex, or special names like UND/ABS */
  sectionName: string;
  visibility: string;
  imported: boolean;
}

export interface StringEntry {
  addr: number;
  sectionName: string;
  value: string;
}

export interface Relocation {
  addr: number;
  type: number;
  typeName: string;
  symbolName: string;
  addend: bigint;
  sectionName: string;
}

/** A basic block inside a function. */
export interface BasicBlock {
  id: string;
  start: number;
  /** end is exclusive (one past last instruction byte) */
  end: number;
  insts: Instruction[];
  successors: number[];
  predecessors: number[];
}

export interface Function_ {
  name: string;
  addr: number;
  size: number;
  sectionName: string;
  /** entry basic-block start address */
  entry: number;
  blocks: BasicBlock[];
  /** ordered instructions across all blocks (sorted by addr) */
  insts: Instruction[];
  /** call target addrs discovered in the body */
  callTargets: number[];
  /** true when recovered without a symbol table entry */
  recovered: boolean;
  /** feature signature used by the matcher */
  features: FuncFeatures;
}

export interface FuncFeatures {
  /** mnemonic multiset hash components */
  mnemonicCounts: Record<string, number>;
  numInsts: number;
  numBlocks: number;
  numCalls: number;
  numBranches: number;
  numCondBranches: number;
  /** constants appearing in immediations / displacements */
  constants: number[];
  /** callees by name when known */
  calleeNames: string[];
  /** string references (content hash of referenced string) */
  stringRefs: number[];
  /** structural hash over normalized mnemonic stream */
  mnemonicHash: number;
  /** fuzzy hash of normalized instruction sequence (ssdeep-style) */
  fuzzyHash: string;
}

/** Analyzed binary: everything the UI needs. */
export interface AnalyzedBinary {
  id: string;
  fileName: string;
  arch: Arch;
  is64bit: boolean;
  littleEndian: boolean;
  entryPoint: number;
  type: string; // ET_REL / ET_EXEC / ET_DYN
  sections: Section[];
  symbols: Symbol[];
  imports: Symbol[];
  exports: Symbol[];
  strings: StringEntry[];
  relocations: Relocation[];
  functions: Function_[];
  /** address -> function containing it */
  funcIndex: Map<number, Function_>;
  /** address -> cross references (who references this address) */
  xrefs: Map<number, Xref[]>;
  /** name -> symbol/function (user renames included) */
  nameIndex: Map<string, number>;
  /** raw file bytes retained for byte-level diffs */
  fileBytes: Bytes;
  buildId?: string;
}

export type XrefType = 'call' | 'jump' | 'data' | 'pointer';

export interface Xref {
  from: number;
  to: number;
  type: XrefType;
  funcAddr?: number;
}

/** Matching of one function between two binaries. */
export interface FuncMatch {
  oldAddr?: number;
  newAddr?: number;
  oldName?: string;
  newName?: string;
  score: number;
  reason: string;
  status: 'matched' | 'added' | 'removed' | 'renamed';
}

export type BlockChangeKind = 'added' | 'removed' | 'modified' | 'unchanged';

export interface BlockChange {
  kind: BlockChangeKind;
  oldStart?: number;
  newStart?: number;
  /** aligned instruction rows for side-by-side rendering */
  rows: InstDiffRow[];
  similarity: number;
}

export interface InstDiffRow {
  oldInst?: Instruction;
  newInst?: Instruction;
  kind: BlockChangeKind;
}

export interface FuncDiff {
  match: FuncMatch;
  changes: BlockChange[];
  /** 0..1 overall similarity from LCS over normalized instructions */
  similarity: number;
  changeSummary: { added: number; removed: number; modified: number };
}

export interface Annotation {
  /** binary id the annotation belongs to */
  binaryId: string;
  addr: number;
  kind: 'name' | 'comment';
  value: string;
  oldName?: string;
}

export interface ScanRule {
  identifier: string;
  source: string;
}

export interface ScanHit {
  rule: string;
  binaryId: string;
  fileName: string;
  addr: number;
  matchedData: string;
  strings: string[];
}
