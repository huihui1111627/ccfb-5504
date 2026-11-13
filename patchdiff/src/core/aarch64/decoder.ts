// AArch64 (A64) disassembler.
//
// A64 is a fixed-width 32-bit encoding with a handful of top-level encoding
// families. We decode by dispatching on the top bits, then on per-family
// fields, and render in llvm-objdump style (the on-machine reference):
//   sub sp, sp, #0x10   /   ldr x0, [x1, #8]!   /   b 0x1234
//
// Reference: ARM Architecture Reference Manual, A64 instruction set encodings.
// Only the integer/SIMD instructions emitted by GCC/Clang for C code are
// modeled; unknown encodings become `.long 0x....` (matching objdump behavior
// on data), never a wrong mnemonic.

import type { Bytes, FlowType, Instruction, Operand } from '../types';

// Condition codes, bits 0..3. llvm-objdump renders the HS/LO naming for the
// unsigned pair (codes 2/3) rather than CS/CC.
const COND = ['eq', 'ne', 'hs', 'lo', 'mi', 'pl', 'vs', 'vc', 'hi', 'ls', 'ge', 'lt', 'gt', 'le', 'al', 'nv'];

// X0..x30; 31 is either zr or sp depending on context.
const XREG = Array.from({ length: 31 }, (_, i) => `x${i}`);
const WREG = Array.from({ length: 31 }, (_, i) => `w${i}`);

function xreg(n: number, allowSp = true): string {
  if (n === 31) return allowSp ? 'sp' : 'xzr';
  return `x${n}`;
}
function wreg(n: number, allowSp = true): string {
  if (n === 31) return allowSp ? 'wsp' : 'wzr';
  return `w${n}`;
}

function regOp(reg: string): Operand {
  return { kind: 'reg', reg };
}
function immOp(v: bigint): Operand {
  return { kind: 'imm', imm: v };
}
function memOp(base: string | undefined, disp: bigint, index?: string, opts: { pre?: boolean; post?: boolean; signed?: boolean } = {}): Operand {
  return {
    kind: 'mem',
    mem: { base, index, disp, scale: index ? 1n : undefined } as never,
  };
}

interface A64Result {
  mnemonic: string;
  operands: Operand[];
  opStr: string;
  flow: FlowType;
  target?: number;
  invalid?: boolean;
}

function signExtend(v: number, bits: number): number {
  const m = 1 << (bits - 1);
  return (v ^ m) - m;
}

function bitmask(width: 32 | 64, n: number, immr: number, imms: number): bigint | null {
  // DecodeBitMasks per ARM ARM (pseudocode, simplified).
  const Nbit = n;
  if (width === 32 && Nbit !== 0) return null;
  // len = highest set bit of (N:NOT(imms)).
  const combined = (Nbit << 6) | ((~imms) & 0x3f);
  let len = -1;
  for (let l = 5; l >= 0; l--) {
    if ((combined >> l) & 1) { len = l; break; }
  }
  if (len < 0) return null;
  const esize = 1 << len;
  if (esize > width) return null;
  const levels = esize - 1;
  const S = imms & levels;
  const R = immr & levels;
  // Build the element: low (S+1) bits set.
  let welem: bigint;
  if (S + 1 === esize) welem = (1n << BigInt(esize)) - 1n;
  else welem = (1n << BigInt(S + 1)) - 1n;
  // Rotate right by R within esize.
  const rBig = BigInt(R);
  const eBig = BigInt(esize);
  const maskE = (1n << eBig) - 1n;
  const telem = (((welem >> rBig) | (welem << (eBig - rBig))) & maskE);
  // Replicate across the register width.
  const repeats = width / esize;
  let result = 0n;
  for (let i = 0; i < repeats; i++) result |= telem << BigInt(i * esize);
  return BigInt.asUintN(width, result);
}

// Move wide (immediate): MOVN/MOVZ/MOVK, sf | opc | 100101 hw imm16 Rd
function decodeMoveWide(w: number, opc: number, hw: number, imm16: number, rd: number): A64Result {
  const is64 = w === 1;
  const reg = is64 ? xreg(rd, false) : wreg(rd, false);
  const shift = hw * 16;
  const base = BigInt(imm16) << BigInt(shift);
  const mn = opc === 0 ? 'movn' : opc === 2 ? 'movz' : 'movk';

  // Canonical aliases llvm-objdump emits.
  // movn Rd, #imm16 == mov Rd, #~(imm16<<shift)  (one's complement, sign shown).
  if (mn === 'movn') {
    const widthBits = is64 ? 64 : 32;
    const flipped = BigInt.asIntN(widthBits, ~base & ((1n << BigInt(widthBits)) - 1n));
    // movn #0 (any shift) is the all-ones constant; objdump prints a plain mov.
    return {
      mnemonic: 'mov',
      operands: [regOp(reg), immOp(flipped)],
      opStr: `${reg}, ${formatImm(flipped)}`,
      flow: 'normal',
    };
  }
  // movz with no shift and a small constant renders as plain "mov".
  if (mn === 'movz' && hw === 0) {
    return {
      mnemonic: 'mov',
      operands: [regOp(reg), immOp(BigInt(imm16))],
      opStr: `${reg}, #0x${imm16.toString(16)}`,
      flow: 'normal',
    };
  }
  // movk keeps its mnemonic; the operand is the 16-bit chunk, not the shifted value.
  if (mn === 'movk') {
    const shiftStr = shift ? `, lsl #${shift}` : '';
    return {
      mnemonic: 'movk',
      operands: [regOp(reg), immOp(BigInt(imm16))],
      opStr: `${reg}, #0x${imm16.toString(16)}${shiftStr}`,
      flow: 'normal',
    };
  }
  const ops = [regOp(reg), immOp(base)];
  const shiftStr = shift ? `, lsl #${shift}` : '';
  return {
    mnemonic: mn,
    operands: ops,
    opStr: `${reg}, #0x${base.toString(16)}${shiftStr}`,
    flow: 'normal',
  };
}

function formatImm(v: bigint): string {
  if (v < 0n) return `#-0x${(-v).toString(16)}`;
  return `#0x${v.toString(16)}`;
}

// Add/subtract immediate: sf|op|S 100010 sh imm12 Rn Rd
function decodeAddSubImm(instr: number): A64Result | null {
  const sf = (instr >> 31) & 1;
  const op = (instr >> 30) & 1; // 0 add, 1 sub
  const S = (instr >> 29) & 1;
  const sh = (instr >> 22) & 1;
  const imm12 = (instr >> 10) & 0xfff;
  const rn = (instr >> 5) & 31;
  const rd = instr & 31;
  const is64 = sf === 1;
  // When the shift bit is set, objdump prints the raw imm12 plus ", lsl #12"
  // rather than the pre-shifted value.
  const imm = BigInt(imm12);
  const shiftTxt = sh ? ', lsl #12' : '';
  const regN = is64 ? xreg(rn) : wreg(rn);
  const regD = is64 ? xreg(rd, !S) : wreg(rd, !S);
  let mn: string;
  if (S) mn = op ? 'subs' : 'adds';
  else mn = op ? 'sub' : 'add';
  // Canonical cmn/cmp: adds/subs with Rd == zr
  if (S && rd === 31) {
    mn = op ? 'cmp' : 'cmn';
    return {
      mnemonic: mn, operands: [regOp(regN), immOp(imm)],
      opStr: `${regN}, #0x${imm.toString(16)}${shiftTxt}`, flow: 'normal',
    };
  }
  // Canonical mov: add rd, zr, #imm. Rn=31 means zr only when it is not the
  // stack-pointer encoding; for ADD/SUB (immediate) Rn=31 is SP, so the mov
  // alias applies solely to the 32-bit form where Rn=wsp is unusable as a
  // move source for a GPR destination.
  if (!S && !op && rn === 31 && rd !== 31 && !is64) {
    return {
      mnemonic: 'mov', operands: [regOp(regD), immOp(imm)],
      opStr: `${regD}, #0x${imm.toString(16)}`, flow: 'normal',
    };
  }
  return {
    mnemonic: mn,
    operands: [regOp(regD), regOp(regN), immOp(imm)],
    opStr: `${regD}, ${regN}, #0x${imm.toString(16)}${shiftTxt}`,
    flow: 'normal',
  };
}

// Logical immediate: sf opc 100100 N immr imms Rn Rd
function decodeLogicalImm(instr: number): A64Result | null {
  const sf = (instr >> 31) & 1;
  const opc = (instr >> 29) & 3;
  const N = (instr >> 22) & 1;
  const immr = (instr >> 16) & 0x3f;
  const imms = (instr >> 10) & 0x3f;
  const rn = (instr >> 5) & 31;
  const rd = instr & 31;
  const width: 32 | 64 = sf ? 64 : 32;
  if (!sf && N) return null;
  const mask = bitmask(width, N, immr, imms);
  if (mask === null) return null;
  const regN = sf ? xreg(rn, false) : wreg(rn, false);
  const regD = sf ? xreg(rd, false) : wreg(rd, false);
  const mnames = ['and', 'orr', 'eor', 'ands'];
  let mn = mnames[opc];
  // Rn == zr: orr -> mov; and -> mov (with mask); eor zr -> ...
  if (rn === 31 && (opc === 1)) {
    return {
      mnemonic: 'mov', operands: [regOp(regD), immOp(mask)],
      opStr: `${regD}, #0x${mask.toString(16)}`, flow: 'normal',
    };
  }
  if (rd === 31 && opc === 3) {
    mn = 'tst';
    return {
      mnemonic: 'tst', operands: [regOp(regN), immOp(mask)],
      opStr: `${regN}, #0x${mask.toString(16)}`, flow: 'normal',
    };
  }
  return {
    mnemonic: mn,
    operands: [regOp(regD), regOp(regN), immOp(mask)],
    opStr: `${regD}, ${regN}, #0x${mask.toString(16)}`,
    flow: 'normal',
  };
}

// EXTR (extract register): sf 0 op 0111 00 Rm imm6 Rn Rd.
// With Rm == Rn it is the canonical ROR (rotate right) alias.
function decodeExtr(instr: number): A64Result | null {
  const sf = (instr >> 31) & 1;
  const rm = (instr >> 16) & 31;
  const imm6 = (instr >> 10) & 0x3f;
  const rn = (instr >> 5) & 31;
  const rd = instr & 31;
  const R = (n: number) => (sf ? xreg(n, false) : wreg(n, false));
  if (rm === rn) {
    return {
      mnemonic: 'ror', operands: [regOp(R(rd)), regOp(R(rn)), immOp(BigInt(imm6))],
      opStr: `${R(rd)}, ${R(rn)}, #0x${imm6.toString(16)}`, flow: 'normal',
    };
  }
  return {
    mnemonic: 'extr', operands: [regOp(R(rd)), regOp(R(rn)), regOp(R(rm)), immOp(BigInt(imm6))],
    opStr: `${R(rd)}, ${R(rn)}, ${R(rm)}, #0x${imm6.toString(16)}`, flow: 'normal',
  };
}

// Bitfield ops: sbfm/ubfm/bfm — also canonical as asr/lsl/lsr/sxt*/uxt*
function decodeBitfield(instr: number): A64Result | null {
  const sf = (instr >> 31) & 1;
  const opc = (instr >> 29) & 3;
  const immr = (instr >> 16) & 0x3f;
  const imms = (instr >> 10) & 0x3f;
  const rn = (instr >> 5) & 31;
  const rd = instr & 31;
  const width = sf ? 64 : 32;
  if (opc === 3) return null;
  const regN = sf ? xreg(rn, false) : wreg(rn, false);
  const regD = sf ? xreg(rd, false) : wreg(rd, false);
  const base = ['sbfm', 'bfm', 'ubfm'][opc];

  // Canonical aliases.
  // Rotate right via sbfm/ubfm with imms == width-1 and immr > 0.
  if (imms === width - 1 && immr > 0) {
    return {
      mnemonic: 'ror', operands: [regOp(regD), regOp(regN), immOp(BigInt(immr))],
      opStr: `${regD}, ${regN}, #0x${immr.toString(16)}`, flow: 'normal',
    };
  }
  if (opc === 2) {
    // ubfm aliases: lsl/lsr/utx...
    if (immr === 0 && imms === width - 1) {
      return { mnemonic: 'mov', operands: [regOp(regD), regOp(regN)], opStr: `${regD}, ${regN}`, flow: 'normal' };
    }
    if (imms === width - 1) {
      return { mnemonic: 'lsr', operands: [regOp(regD), regOp(regN), immOp(BigInt(immr))], opStr: `${regD}, ${regN}, #${immr}`, flow: 'normal' };
    }
    if (immr === 0) {
      const sz = imms + 1;
      const ext = sf ? (sz === 64 ? 'lsl' : `uxtb${sz === 8 ? '' : sz === 16 ? 'h' : 'w'}`) : 'lsl';
      if (ext === 'lsl') {
        return { mnemonic: 'lsl', operands: [regOp(regD), regOp(regN), immOp(BigInt(width - sz))], opStr: `${regD}, ${regN}, #${width - sz}`, flow: 'normal' };
      }
      return { mnemonic: ext, operands: [regOp(regD), regOp(regN)], opStr: `${regD}, ${regN}`, flow: 'normal' };
    }
  }
  if (opc === 0) {
    // sbfm aliases: asr, sxtb/sxth, sxtw
    if (immr === 0 && imms === width - 1) {
      return { mnemonic: 'mov', operands: [regOp(regD), regOp(regN)], opStr: `${regD}, ${regN}`, flow: 'normal' };
    }
    if (imms === width - 1) {
      return { mnemonic: 'asr', operands: [regOp(regD), regOp(regN), immOp(BigInt(immr))], opStr: `${regD}, ${regN}, #${immr}`, flow: 'normal' };
    }
    if (immr === 0) {
      const ext = sf ? (imms === 7 ? 'sxtb' : imms === 15 ? 'sxth' : imms === 31 ? 'sxtw' : base) : (imms === 7 ? 'sxtb' : imms === 15 ? 'sxth' : base);
      if (ext !== base) return { mnemonic: ext, operands: [regOp(regD), regOp(regN)], opStr: `${regD}, ${regN}`, flow: 'normal' };
    }
  }
  return {
    mnemonic: base,
    operands: [regOp(regD), regOp(regN), immOp(BigInt(immr)), immOp(BigInt(imms))],
    opStr: `${regD}, ${regN}, #${immr}, #${imms}`,
    flow: 'normal',
  };
}

// Resolve the load/store mnemonic and transfer width from size/opc fields.
function ldStMnemonic(size: number, opc: number, load: boolean): { mn: string; is64: boolean } {
  if (!load) {
    if (size === 0) return { mn: 'strb', is64: false };
    if (size === 1) return { mn: 'strh', is64: false };
    if (size === 2) return { mn: 'str', is64: false };
    return { mn: 'str', is64: true };
  }
  if (size === 0) return { mn: 'ldrb', is64: false };
  if (size === 1) return { mn: 'ldrh', is64: false };
  if (size === 2) {
    // opc=10 with size=10 is ldrsw into a 64-bit register.
    return opc === 2 ? { mn: 'ldrsw', is64: true } : { mn: 'ldr', is64: false };
  }
  return { mn: 'ldr', is64: true };
}

// Load/store unsigned immediate (size 11 1 0 0 1 opc imm12 Rn Rt)
function decodeLdStUnsigned(instr: number, _addr: number): A64Result | null {
  const size = (instr >> 30) & 3;
  const opc = (instr >> 22) & 3;
  const imm12 = (instr >> 10) & 0xfff;
  const rn = (instr >> 5) & 31;
  const rt = instr & 31;
  const load = opc !== 0;
  const { mn, is64 } = ldStMnemonic(size, opc, load);
  const scale = size === 3 ? 8 : size === 2 ? 4 : size === 1 ? 2 : 1;
  const reg = is64 ? xreg(rt, false) : wreg(rt, false);
  const base = rn === 31 ? 'sp' : `x${rn}`;
  const disp = BigInt(imm12 * scale);
  const dispStr = imm12 === 0 ? `[${base}]` : `[${base}, #0x${disp.toString(16)}]`;
  return {
    mnemonic: mn,
    operands: load ? [regOp(reg), memOp(base, disp)] : [memOp(base, disp), regOp(reg)],
    opStr: load ? `${reg}, ${dispStr}` : `${reg}, ${dispStr}`,
    flow: 'normal',
  };
}

// Load/store register (scaled register offset / extended): used for [xn, xm]
function decodeLdStRegister(instr: number): A64Result | null {
  const size = (instr >> 30) & 3;
  const V = (instr >> 26) & 1;
  const opc = (instr >> 22) & 3;
  const rm = (instr >> 16) & 31;
  const option = (instr >> 13) & 7;
  const S = (instr >> 12) & 1;
  const rn = (instr >> 5) & 31;
  const rt = instr & 31;
  if (V || opc > 1) return decodeLdStSIMD(instr);
  const load = opc !== 0;
  const { mn, is64 } = ldStMnemonic(size, opc, load);
  const reg = is64 ? xreg(rt, false) : wreg(rt, false);
  const base = rn === 31 ? 'sp' : `x${rn}`;
  // The index register width follows the extend option: w-register for
  // uxtw/sxtw/uxtb/uxth, x-register for uxtx/sxtx/lsl(option=3).
  const wideIndex = option === 3 || option === 7;
  const idx = wideIndex ? xreg(rm, false) : wreg(rm, false);
  const extNames = ['uxtb', 'uxth', 'uxtw', 'uxtx', 'sxtb', 'sxth', 'sxtw', 'sxtx'];
  const scale = size === 3 ? 8 : size === 2 ? 4 : size === 1 ? 2 : 1;
  let optStr: string;
  if (option === 3) {
    // LSL: shift amount shown only when S=1.
    optStr = S ? `, lsl #${scale}` : '';
  } else {
    // Extended-register shift: S=1 means shift by the access size (log2 scale).
    optStr = `, ${extNames[option]}` + (S ? ` #${Math.log2(scale)}` : '');
  }
  return {
    mnemonic: mn,
    operands: [],
    opStr: `${reg}, [${base}, ${idx}${optStr}]`,
    flow: 'normal',
  };
}

// Unscaled immediate load/store (stur/ldur/sturb/ldurh...): encoding 11 1 0
// 0 0 with index-mode bits 00. The 9-bit signed offset is byte granular, no
// scaling, which distinguishes it from the scaled pre/post forms.
function decodeLdStUnscaled(instr: number): A64Result | null {
  const size = (instr >> 30) & 3;
  const opc = (instr >> 22) & 3;
  const imm9 = signExtend((instr >> 12) & 0x1ff, 9);
  const rn = (instr >> 5) & 31;
  const rt = instr & 31;
  const load = opc !== 0;
  const { mn, is64 } = ldStMnemonic(size, opc, load);
  // Unscaled variants use the "ur" spelling.
  const mnUnscaled = mn.replace('ldr', 'ldur').replace('str', 'stur');
  const reg = is64 ? xreg(rt, false) : wreg(rt, false);
  const base = rn === 31 ? 'sp' : `x${rn}`;
  const offTxt = imm9 < 0 ? `-0x${(-imm9).toString(16)}` : `0x${imm9.toString(16)}`;
  const mem = imm9 === 0 ? `[${base}]` : `[${base}, #${offTxt}]`;
  return { mnemonic: mnUnscaled, operands: [], opStr: load ? `${reg}, ${mem}` : `${reg}, ${mem}`, flow: 'normal' };
}

function decodeLdStSIMD(instr: number): A64Result | null {
  const size = (instr >> 30) & 3;
  const opc = (instr >> 22) & 3;
  const imm12 = (instr >> 10) & 0xfff;
  const rn = (instr >> 5) & 31;
  const rt = instr & 31;
  const base = rn === 31 ? 'sp' : `x${rn}`;
  const q = size === 0 && ((instr >> 30) & 1) === 0 ? 0 : 1;
  const reg = `q${rt}`;
  const scale = opc === 2 ? 16 : size === 3 ? 8 : size === 2 ? 4 : 1;
  const disp = BigInt(imm12 * scale);
  const load = ((instr >> 22) & 1) === 1;
  const mn = load ? (opc === 2 ? 'ldr' : 'ldr') : 'str';
  void q;
  const dispStr = imm12 === 0 ? `[${base}]` : `[${base}, #0x${disp.toString(16)}]`;
  return { mnemonic: mn, operands: [], opStr: `${reg}, ${dispStr}`, flow: 'normal' };
}

// Load/store pre/post/indexed: size 11 1 0 0 0 opc imm9 mode Rn Rt, mode 01/10/11
function decodeLdStPair(instr: number): A64Result | null {
  const opc = (instr >> 30) & 3;
  const load = ((instr >> 22) & 1) === 1;
  const imm7 = signExtend((instr >> 15) & 0x7f, 7);
  // Pair addressing mode (bits 24..23): 00 post-index, 01/10 signed offset
  // (both print the plain [Rn,#off] form), 11 pre-index with writeback.
  const pairMode = ((instr >> 24) & 1) << 1 | ((instr >> 23) & 1);
  const mode: 'post' | 'offset' | 'pre' = pairMode === 0 ? 'post' : pairMode === 3 ? 'pre' : 'offset';
  const rn = (instr >> 5) & 31;
  const rt = instr & 31;
  const rt2 = (instr >> 10) & 31;
  const is64 = (opc & 2) === 2;
  const scale = is64 ? 8 : 4;
  const r1 = is64 ? xreg(rt, false) : wreg(rt, false);
  const r2 = is64 ? xreg(rt2, false) : wreg(rt2, false);
  const base = rn === 31 ? 'sp' : `x${rn}`;
  const off = imm7 * scale;
  const mn = load ? 'ldp' : 'stp';
  const offTxt = off < 0 ? `-0x${(-off).toString(16)}` : `0x${off.toString(16)}`;
  let mem: string;
  if (mode === 'offset') mem = `[${base}, #${offTxt}]`;
  else if (mode === 'post') mem = `[${base}], #${offTxt}`;
  else mem = `[${base}, #${offTxt}]!`;
  return { mnemonic: mn, operands: [], opStr: load ? `${r1}, ${r2}, ${mem}` : `${r1}, ${r2}, ${mem}`, flow: 'normal' };
}

// Load literal: 01 011000 opc imm19 Rt — PC-relative ldr
function decodeLoadLiteral(instr: number, addr: number): A64Result {
  const opc = (instr >> 30) & 3;
  const imm19 = signExtend((instr >> 5) & 0x7ffff, 19);
  const rt = instr & 31;
  const is64 = opc === 1;
  const reg = is64 ? xreg(rt, false) : wreg(rt, false);
  const target = addr + imm19 * 4;
  return {
    mnemonic: 'ldr',
    operands: [regOp(reg), { kind: 'mem', mem: { base: 'pc', disp: BigInt(target) } as never }],
    opStr: `${reg}, 0x${target.toString(16)}`,
    flow: 'normal',
    target,
  };
}

// Unconditional immediate branch: 000101 / 100101 (BL) / 110101 (unreachable)
function decodeBranchImm(instr: number, addr: number): A64Result {
  const link = (instr >> 31) & 1;
  const imm26 = signExtend(instr & 0x3ffffff, 26);
  const target = addr + imm26 * 4;
  return {
    mnemonic: link ? 'bl' : 'b',
    operands: [immOp(BigInt(target))],
    opStr: `0x${target.toString(16)}`,
    flow: link ? 'call' : 'direct-jump',
    target,
  };
}

// Conditional branch: 01010100 imm19 0 cond
function decodeCondBranch(instr: number, addr: number): A64Result {
  const imm19 = signExtend((instr >> 5) & 0x7ffff, 19);
  const cond = instr & 15;
  const target = addr + imm19 * 4;
  return {
    mnemonic: `b.${COND[cond]}`,
    operands: [immOp(BigInt(target))],
    opStr: `0x${target.toString(16)}`,
    flow: 'conditional-jump',
    target,
  };
}

// Compare & branch: 0111010 op imm19 Rt
function decodeCompareBranch(instr: number, addr: number): A64Result {
  const op = (instr >> 24) & 1;
  const sf = (instr >> 31) & 1;
  const imm19 = signExtend((instr >> 5) & 0x7ffff, 19);
  const rt = instr & 31;
  const reg = sf ? xreg(rt, false) : wreg(rt, false);
  const target = addr + imm19 * 4;
  return {
    mnemonic: op ? 'cbnz' : 'cbz',
    operands: [regOp(reg), immOp(BigInt(target))],
    opStr: `${reg}, 0x${target.toString(16)}`,
    flow: 'conditional-jump',
    target,
  };
}

// Test & branch: 0110110 op b40 imm14 Rt
function decodeTestBranch(instr: number, addr: number): A64Result {
  const op = (instr >> 24) & 1;
  const is64 = (instr >> 31) & 1;
  const b40 = (instr >> 19) & 0x3f;
  const imm14 = signExtend((instr >> 5) & 0x3fff, 14);
  const rt = instr & 31;
  const target = addr + imm14 * 4;
  const bit = b40;
  const reg = is64 ? xreg(rt, false) : wreg(rt, false);
  return {
    mnemonic: op ? 'tbnz' : 'tbz',
    operands: [regOp(reg), immOp(BigInt(bit)), immOp(BigInt(target))],
    opStr: `${reg}, #0x${bit.toString(16)}, 0x${target.toString(16)}`,
    flow: 'conditional-jump',
    target,
  };
}

// Branches/ret via register: 1101011 op4 ...
function decodeBranchReg(instr: number): A64Result | null {
  const op4 = (instr >> 21) & 0xf;
  const rn = (instr >> 5) & 31;
  // 0000 br, 0001 blr, 0010 ret, 0011 drps, 0100 ERETA...
  if (op4 === 0) return { mnemonic: 'br', operands: [regOp(xreg(rn, false))], opStr: `x${rn === 31 ? 'zr' : rn}`, flow: 'indirect-jump' };
  if (op4 === 1) return { mnemonic: 'blr', operands: [regOp(xreg(rn, false))], opStr: `x${rn === 31 ? 'zr' : rn}`, flow: 'call' };
  if (op4 === 2) {
    if (rn === 30) return { mnemonic: 'ret', operands: [], opStr: '', flow: 'return' };
    return { mnemonic: 'ret', operands: [regOp(xreg(rn, false))], opStr: `x${rn}`, flow: 'return' };
  }
  return null;
}

// Hints/system: 1101010100 ...
function decodeHints(instr: number): A64Result | null {
  const opc = (instr >> 21) & 0x7;
  const crm = (instr >> 8) & 0xf;
  // NOP = 1101010100 000 0011111 0000 11111
  if (opc === 0) {
    if (crm === 0) return { mnemonic: 'nop', operands: [], opStr: '', flow: 'normal' };
    if (crm === 1) return { mnemonic: 'yield', operands: [], opStr: '', flow: 'normal' };
    if (crm === 2) return { mnemonic: 'wfe', operands: [], opStr: '', flow: 'normal' };
    if (crm === 3) return { mnemonic: 'wfi', operands: [], opStr: '', flow: 'normal' };
    if (crm === 4) return { mnemonic: 'sev', operands: [], opStr: '', flow: 'normal' };
    if (crm === 5) return { mnemonic: 'sevl', operands: [], opStr: '', flow: 'normal' };
  }
  return null;
}

// Data processing — register (add/sub shifted reg, logical shifted reg).
// Dispatch is already split on the M bit, so here M tells us the family.
function decodeDataProcReg(instr: number): A64Result | null {
  const sf = (instr >> 31) & 1;
  const opc = (instr >> 29) & 3;
  const shift = (instr >> 22) & 3;
  const M = (instr >> 24) & 1;
  const rm = (instr >> 16) & 31;
  const imm6 = (instr >> 10) & 0x3f;
  const rn = (instr >> 5) & 31;
  const rd = instr & 31;
  const is64 = sf === 1;
  const rN = is64 ? xreg(rn) : wreg(rn);
  const rM = is64 ? xreg(rm, false) : wreg(rm, false);
  const rD = is64 ? xreg(rd, true) : wreg(rd, true);
  const shiftNames = ['lsl', 'lsr', 'asr', 'ror'];
  const shTxt = imm6 ? `, ${shiftNames[shift]} #${imm6}` : '';

  // Logical shifted register: M=0, opc selects and/orr/eor/ands.
  if (M === 0) {
    // Variable shifts (LSLV/LSRV/ASRV/RORV): bits28..21 = 0xd6 with imm6 in
    // the fixed range 8..11 (the low two bits name the shift). Ordinary
    // logical shifts use imm6 < reg-width, so this separates the two spaces.
    if (((instr >> 21) & 0xff) === 0xd6 && imm6 >= 8 && imm6 <= 11) {
      const vShiftNames: Record<number, string> = { 8: 'lsl', 9: 'lsr', 10: 'asr', 11: 'ror' };
      const pretty = vShiftNames[imm6] ?? 'lsl';
      return { mnemonic: pretty, operands: [regOp(rD), regOp(rN), regOp(rM)], opStr: `${rD}, ${rN}, ${rM}`, flow: 'normal' };
    }
    const names = ['and', 'orr', 'eor', 'ands'];
    let mn = names[opc];
    if (rn === 31 && opc === 1) {
      // orr Rd, zr, Rm{,shift} -> mov/lsl/lsr/asr/ror alias.
      const alias = imm6 ? shiftNames[shift] : 'mov';
      return { mnemonic: alias, operands: [regOp(rD), regOp(rM)], opStr: imm6 ? `${rD}, ${rM}, #${imm6}` : `${rD}, ${rM}`, flow: 'normal' };
    }
    if (rd === 31 && opc === 3) {
      return { mnemonic: 'tst', operands: [regOp(rN), regOp(rM)], opStr: `${rN}, ${rM}${shTxt}`, flow: 'normal' };
    }
    if (rd === 31 && opc === 0) mn = 'and';
    return { mnemonic: mn, operands: [regOp(rD), regOp(rN), regOp(rM)], opStr: `${rD}, ${rN}, ${rM}${shTxt}`, flow: 'normal' };
  }
  // Add/sub shifted register: M=1; opc bit0 = S, bit1 = subtract.
  const S = opc & 1;
  const sub = opc & 2;
  let mn = sub ? (S ? 'subs' : 'sub') : (S ? 'adds' : 'add');
  if (S && rd === 31) {
    mn = sub ? 'cmp' : 'cmn';
    return { mnemonic: mn, operands: [regOp(rN), regOp(rM)], opStr: `${rN}, ${rM}${shTxt}`, flow: 'normal' };
  }
  if (!S && !sub && rn === 31 && !imm6) {
    return { mnemonic: 'mov', operands: [regOp(rD), regOp(rM)], opStr: `${rD}, ${rM}`, flow: 'normal' };
  }
  return { mnemonic: mn, operands: [regOp(rD), regOp(rN), regOp(rM)], opStr: `${rD}, ${rN}, ${rM}${shTxt}`, flow: 'normal' };
}

// Add/subtract extended register: sf op S 0 1 0 0 0 1 3 option imm3 Rn Rd
// Distinguished from shifted-register by bit 21 = 1.
function decodeAddSubExtended(instr: number): A64Result | null {
  if (((instr >> 21) & 1) !== 1) return null;
  const sf = (instr >> 31) & 1;
  const op = (instr >> 30) & 1;
  const S = (instr >> 29) & 1;
  const option = (instr >> 13) & 7;
  const imm3 = (instr >> 10) & 7;
  const rm = (instr >> 16) & 31;
  const rn = (instr >> 5) & 31;
  const rd = instr & 31;
  const is64 = sf === 1;
  const R = (n: number, sp = true) => (is64 ? xreg(n, sp) : wreg(n, sp));
  // 32-bit extend options (uxtb/uxth/uxtw and signed twins) use a w-register;
  // uxtx/sxtx and the lsl-equivalent option 3 use the full x-register.
  const wide = option === 3 || option === 7 || option === 6 || option === 2 && false;
  const idxIs64 = option === 3 || option === 7;
  const idxReg = idxIs64 ? xreg(rm, false) : wreg(rm, false);
  const extNames = ['uxtb', 'uxth', 'uxtw', 'uxtx', 'sxtb', 'sxth', 'sxtw', 'sxtx'];
  let mn = op ? (S ? 'subs' : 'sub') : (S ? 'adds' : 'add');
  if (S && rd === 31) {
    mn = op ? 'cmp' : 'cmn';
    const ext = `${idxReg}, ${extNames[option]}` + (imm3 ? ` #${imm3}` : '');
    return { mnemonic: mn, operands: [], opStr: `${R(rn)}, ${ext}`, flow: 'normal' };
  }
  const ext = `${idxReg}, ${extNames[option]}` + (imm3 ? ` #${imm3}` : '');
  return { mnemonic: mn, operands: [], opStr: `${R(rd, true)}, ${R(rn)}, ${ext}`, flow: 'normal' };
}

// Multiply / divide family inside the data-processing register space (M field)
function decodeMulDiv(instr: number): A64Result | null {
  const sf = (instr >> 31) & 1;
  const o0 = (instr >> 30) & 1;
  const op54 = (instr >> 29) & 3;
  const rm = (instr >> 16) & 31;
  const o1 = (instr >> 15) & 1;
  const ra = (instr >> 10) & 31;
  const rn = (instr >> 5) & 31;
  const rd = instr & 31;
  const is64 = sf === 1;
  const R = (n: number, sp = true) => (is64 ? xreg(n, sp) : wreg(n, sp));
  // UDIV/SDIV: 01 0 1011 0 o1 ... ; o1=0 udiv, 1 sdiv
  if (op54 === 1 && o1 === 1) {
    // check full pattern 0x1ac00000-ish: distinguish via bits 24..21 = 1011
    if (((instr >> 21) & 0xf) === 0xb) {
      const mn = o0 ? 'sdiv' : 'udiv';
      return { mnemonic: mn, operands: [regOp(R(rd, false)), regOp(R(rn)), regOp(R(rm, false))], opStr: `${R(rd, false)}, ${R(rn)}, ${R(rm, false)}`, flow: 'normal' };
    }
  }
  // MADD/MSUB: 00 o0 1101 0 o0? ... bit pattern: bits 24..21 = 1101
  if (((instr >> 21) & 0xf) === 0xd) {
    const neg = o1;
    const mn64 = neg ? 'msub' : 'madd';
    const rA = R(ra, false);
    return {
      mnemonic: is64 ? mn64 : neg ? 'msub' : 'madd',
      operands: [regOp(R(rd, false)), regOp(R(rn)), regOp(R(rm, false)), regOp(rA)],
      opStr: `${R(rd, false)}, ${R(rn)}, ${R(rm, false)}, ${rA}`,
      flow: 'normal',
    };
  }
  return null;
}

// Moves between register types / address generation: movn handled elsewhere;
// ADR/ADRP here.
function decodeAdr(instr: number, addr: number): A64Result {
  const op = (instr >> 31) & 1; // 0 ADR, 1 ADRP
  const rd = instr & 31;
  const immlo = (instr >> 29) & 3;
  const immhi = (instr >> 5) & 0x7ffff;
  const imm = signExtend((immhi << 2) | immlo, 21);
  const target = op ? ((addr & ~0xfff) + imm * 4096) : addr + imm;
  return {
    mnemonic: op ? 'adrp' : 'adr',
    operands: [regOp(xreg(rd, false)), immOp(BigInt(target))],
    opStr: `x${rd}, 0x${(target >>> 0).toString(16)}`,
    flow: 'normal',
    target,
  };
}

// Load/store unsigned immediate with writeback variants (pre/post index): 11 1 0 0 0
function decodeLdStImmPrePost(instr: number): A64Result | null {
  const size = (instr >> 30) & 3;
  const opc = (instr >> 22) & 3;
  const imm9 = signExtend((instr >> 12) & 0x1ff, 9);
  const idxMode = (instr >> 10) & 3; // 01 post, 11 pre; 10 unsigned offset handled elsewhere
  const rn = (instr >> 5) & 31;
  const rt = instr & 31;
  if (idxMode !== 1 && idxMode !== 3) return null;
  const load = opc !== 0;
  const { mn, is64 } = ldStMnemonic(size, opc, load);
  const reg = is64 ? xreg(rt, false) : wreg(rt, false);
  const base = rn === 31 ? 'sp' : `x${rn}`;
  const offTxt = imm9 < 0 ? `-0x${(-imm9).toString(16)}` : `0x${imm9.toString(16)}`;
  const mem = idxMode === 3 ? `[${base}, #${offTxt}]!` : `[${base}], #${offTxt}`;
  return { mnemonic: mn, operands: [], opStr: `${reg}, ${mem}`, flow: 'normal' };
}

// Conditional select / compare/branch family: csel/csinc/cset/cinc/csinv/cneg
function decodeCsel(instr: number): A64Result | null {
  const sf = (instr >> 31) & 1;
  const op2 = (instr >> 10) & 3;
  const rm = (instr >> 16) & 31;
  const cond = (instr >> 12) & 15;
  const rn = (instr >> 5) & 31;
  const rd = instr & 31;
  const is64 = sf === 1;
  // In conditional-select R31 encodes the zero register (never SP).
  const R = (n: number) => (is64 ? xreg(n, false) : wreg(n, false));
  const base = ['csel', 'csinc', 'csinv', 'csneg'][op2];
  // cset: csinc with rn=rm=zr and cond inverted
  if (op2 === 1 && rn === 31 && rm === 31) {
    const inv = COND[cond ^ 1];
    return { mnemonic: 'cset', operands: [regOp(R(rd)), { kind: 'reg', reg: inv }], opStr: `${R(rd)}, ${inv}`, flow: 'normal' };
  }
  // cinc: csinc rm=rn? objdump: cinc rd, rn, cond == csinc rd, rn, rn, invert
  if (op2 === 1 && rm === rn) {
    return { mnemonic: 'cinc', operands: [regOp(R(rd)), regOp(R(rn)), { kind: 'reg', reg: COND[cond] }], opStr: `${R(rd)}, ${R(rn)}, ${COND[cond]}`, flow: 'normal' };
  }
  return {
    mnemonic: base,
    operands: [regOp(R(rd)), regOp(R(rn)), regOp(R(rm)), { kind: 'reg', reg: COND[cond] }],
    opStr: `${R(rd)}, ${R(rn)}, ${R(rm)}, ${COND[cond]}`,
    flow: 'normal',
  };
}

// Extend/move wide register: sxtw/uxtw etc. via SXTW/UXTW aliases (op=0/1, Rn, #shift)
function decodeSignExtendReg(instr: number): A64Result | null {
  const sf = (instr >> 31) & 1;
  const op = (instr >> 30) & 1;
  const imms = (instr >> 10) & 0x3f;
  const immr = (instr >> 16) & 0x3f;
  const rn = (instr >> 5) & 31;
  const rd = instr & 31;
  // sxtw: sf=1 op=0 imms=31 immr=0; uxtw: sf=1 op=1 imms=31
  if (sf && imms === 31 && immr === 0) {
    const mn = op ? 'uxtw' : 'sxtw';
    return { mnemonic: mn, operands: [regOp(xreg(rd, false)), regOp(wreg(rn, false))], opStr: `x${rd}, w${rn === 31 ? 'zr' : rn}`, flow: 'normal' };
  }
  return null;
}

// Top-level dispatch on the major encoding groups.
export function decodeA64(instrWord: number, addr: number): A64Result {
  // Unallocated default.
  const invalid: A64Result = {
    mnemonic: '.long',
    operands: [immOp(BigInt(instrWord >>> 0))],
    opStr: `0x${(instrWord >>> 0).toString(16)}`,
    flow: 'normal',
    invalid: true,
  };

  // 11010101000/11010101001 hints/sys
  if ((instrWord & 0xffe0001f) === 0xd503201f) {
    const h = decodeHints(instrWord);
    if (h) return h;
  }
  // Exception generation: SVC/HVC/BRK/HLT — 11010100 ...
  if ((instrWord & 0xff00001f) === 0xd4000001 || (instrWord & 0xffe0001f) === 0xd4200000) {
    const opc = (instrWord >> 21) & 0xf;
    const imm16 = (instrWord >> 5) & 0xffff;
    const names = ['', 'svc', 'hvc', 'smc', '', 'brk', 'hlt'];
    const mn = names[opc];
    if (mn) return { mnemonic: mn, operands: [immOp(BigInt(imm16))], opStr: `#0x${imm16.toString(16)}`, flow: mn === 'svc' ? 'syscall' : 'normal' };
  }

  // Branches.
  if ((instrWord >>> 26) === 0b000101 || (instrWord >>> 26) === 0b100101) return decodeBranchImm(instrWord, addr);
  if ((instrWord & 0xff000010) === 0x54000000) return decodeCondBranch(instrWord, addr);
  if ((instrWord & 0x7e000000) === 0x34000000) return decodeCompareBranch(instrWord, addr);
  if ((instrWord & 0x7e000000) === 0x36000000) return decodeTestBranch(instrWord, addr);
  // Unconditional branch register: br/blr/ret. All three have bits 31..25
  // = 1101011 (0x6b when shifted), i.e. (word >> 25) & 0x7f === 0x6b.
  if (((instrWord >> 25) & 0x7f) === 0x6b) {
    const r = decodeBranchReg(instrWord);
    if (r) return r;
  }
  if ((instrWord & 0xfc000000) === 0x14000000) return decodeBranchImm(instrWord, addr);

  // ADR/ADRP: x 10000 imm...
  if ((instrWord & 0x1f000000) === 0x10000000) return decodeAdr(instrWord, addr);

  // Load literal: 00011000 / 01011000
  if ((instrWord & 0x3b000000) === 0x18000000) return decodeLoadLiteral(instrWord, addr);

  // Move wide: xx 100101
  if ((instrWord & 0x1f800000) === 0x12800000) {
    const sf = (instrWord >> 31) & 1;
    const opc = (instrWord >> 29) & 3;
    const hw = (instrWord >> 21) & 3;
    const imm16 = (instrWord >> 5) & 0xffff;
    const rd = instrWord & 31;
    return decodeMoveWide(sf, opc, hw, imm16, rd);
  }

  // Bitfield/EXTR family: fixed bits 28..24 = 10011. bit23=1 selects EXTR,
  // bit23=0 selects sbfm/bfm/ubfm. Checked before add/sub (sf=1 collision).
  if (((instrWord >> 24) & 0x1f) === 0b10011) {
    if (((instrWord >> 23) & 1) === 1) {
      const extr = decodeExtr(instrWord);
      if (extr) return extr;
    }
    const r = decodeBitfield(instrWord);
    if (r) return r;
  }
  // Add/sub immediate: sf op S 100010 ... — bits 28..24 = 10001, sf varies.
  if ((instrWord & 0x1f000000) === 0x11000000 || (instrWord & 0x1f000000) === 0x13000000) {
    const r = decodeAddSubImm(instrWord);
    if (r) return r;
  }
  // Logical immediate: xx 100100
  if ((instrWord & 0x1f800000) === 0x12000000) {
    const r = decodeLogicalImm(instrWord);
    if (r) return r;
  }

  // Data processing register, bits 28..25 = 0101. sf (bit31) varies, so the
  // masked value is 0x0a/0x1a (logical, M=0) or 0x0b/0x1b (add/sub, M=1).
  if ((instrWord & 0x1f000000) === 0x0a000000 || (instrWord & 0x1f000000) === 0x1a000000) {
    // Conditional select (csel/csinc/csinv/csneg): bits 28..21 = 0b11010100.
    if (((instrWord >> 21) & 0xff) === 0xd4) {
      const r = decodeCsel(instrWord);
      if (r) return r;
    }
    const r = decodeDataProcReg(instrWord) ?? decodeMulDiv(instrWord) ?? decodeSignExtendReg(instrWord);
    if (r) return r;
  }
  // Add/sub family, M=1 (bit24=1): masked value 0x0b (32-bit) or 0x1b (64-bit).
  if ((instrWord & 0x1f000000) === 0x0b000000 || (instrWord & 0x1f000000) === 0x1b000000) {
    // Add/sub extended register: bits 28..21 = 0b01011001 (0x59).
    if (((instrWord >> 21) & 0xff) === 0x59) {
      const ext = decodeAddSubExtended(instrWord);
      if (ext) return ext;
    }
    const r = decodeDataProcReg(instrWord) ?? decodeMulDiv(instrWord) ?? decodeCsel(instrWord);
    if (r) return r;
  }

  // Load/store pair: xx 101 0 0 1x (offset/pre/post)
  if ((instrWord & 0x3a000000) === 0x28000000) {
    const r = decodeLdStPair(instrWord);
    if (r) return r;
  }
  // Load/store unsigned immediate: 11 1 0 0 1
  if ((instrWord & 0x3b000000) === 0x39000000) {
    const r = decodeLdStUnsigned(instrWord, addr);
    if (r) return r;
  }
  // Load/store pre/post: 11 1 0 0 0 with mode bits
  if ((instrWord & 0x3b200c00) === 0x38000400 || (instrWord & 0x3b200c00) === 0x38000c00) {
    const r = decodeLdStImmPrePost(instrWord);
    if (r) return r;
  }
  // Unscaled immediate stur/ldur: 11 1 0 0 0, mode bits 00.
  if ((instrWord & 0x3b200c00) === 0x38000000) {
    const r = decodeLdStUnscaled(instrWord);
    if (r) return r;
  }
  // Load/store register offset: 11 1 0 0 0 10
  if ((instrWord & 0x3b200c00) === 0x38200800 || (instrWord & 0x3b200c00) === 0x38200000) {
    const r = decodeLdStRegister(instrWord);
    if (r) return r;
  }

  return invalid;
}

export function disassembleA64Range(bytes: Bytes, baseAddr: number): Instruction[] {
  const out: Instruction[] = [];
  for (let off = 0; off + 4 <= bytes.length; off += 4) {
    const word = (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
    const addr = baseAddr + off;
    const r = decodeA64(word, addr);
    const text = r.opStr ? `${r.mnemonic}\t${r.opStr}` : r.mnemonic;
    out.push({
      addr,
      bytes: bytes.subarray(off, off + 4),
      mnemonic: r.mnemonic,
      opStr: r.opStr,
      text,
      comment: '',
      operands: r.operands,
      flow: r.flow,
      target: r.target,
      invalid: r.invalid,
    });
  }
  return out;
}
