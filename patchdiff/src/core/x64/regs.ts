// x86-64 register definitions and operand decoding helpers.

export type X64Width = 8 | 16 | 32 | 64 | 128 | 256;

// Indexed by the low 3 bits of an opcode / ModRM /rm field; REX.B extends it.
export const GPR64 = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15'];
export const GPR32 = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi',
  'r8d', 'r9d', 'r10d', 'r11d', 'r12d', 'r13d', 'r14d', 'r15d'];
export const GPR16 = ['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di',
  'r8w', 'r9w', 'r10w', 'r11w', 'r12w', 'r13w', 'r14w', 'r15w'];
export const GPR8 = ['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil',
  'r8b', 'r9b', 'r10b', 'r11b', 'r12b', 'r13b', 'r14b', 'r15b'];
// Without REX, /4../7 map onto ah/ch/dh/bh.
export const GPR8_NOREX = ['al', 'cl', 'dl', 'bl', 'ah', 'ch', 'dh', 'bh'];

export const XMM = Array.from({ length: 16 }, (_, i) => `xmm${i}`);
export const YMM = Array.from({ length: 16 }, (_, i) => `ymm${i}`);
export const SEG = ['es', 'cs', 'ss', 'ds', 'fs', 'gs'];

export function gprName(width: X64Width, idx: number, rex: boolean): string {
  switch (width) {
    case 64: return GPR64[idx];
    case 32: return GPR32[idx];
    case 16: return GPR16[idx];
    case 8:
      if (!rex && idx < 8) return GPR8_NOREX[idx];
      return GPR8[idx];
    default:
      throw new Error(`bad gpr width ${width}`);
  }
}

export function vecName(width: 128 | 256, idx: number): string {
  return width === 128 ? XMM[idx] : YMM[idx];
}

export interface Rex {
  present: boolean;
  w: boolean; r: boolean; x: boolean; b: boolean;
}

export interface ModRM {
  mod: number;
  reg: number; // includes REX.R extension
  rm: number;  // includes REX.B extension
  /** full byte for reference */
  raw: number;
}

export interface Sib {
  scale: number;
  index: number; // includes REX.X
  base: number;  // includes REX.B
  raw: number;
}

export interface MemOp {
  base?: string;
  index?: string;
  scale?: number;
  disp: bigint;
  ripTarget?: number;
  width: X64Width;
}

/** Prefix group state accumulated while scanning legacy prefixes. */
export interface Prefixes {
  rex: Rex;
  opsize: boolean;   // 0x66
  addrsize: boolean; // 0x67 (irrelevant in 64-bit flat code, tracked anyway)
  seg: number;       // segment override, -1 if none
  rep: 0 | 0xf3 | 0xf2;
  lock: boolean;
  vex?: VexInfo;
}

export interface VexInfo {
  bytes: 2 | 3;
  /** vector length: 128 or 256 */
  vecLen: 128 | 256;
  /** implied 0F / 0F38 / 0F3A map */
  map: 1 | 2 | 3;
  /** inverted extension bits, already expanded */
  r: boolean; x: boolean; b: boolean;
  /** opcode extra bit (vvvv) */
  vvvv: number;
  /** W bit */
  w: boolean;
  pp: number; // simd prefix: 0 none, 1 0x66, 2 0xF3, 3 0xF2
}
