// x86-64 instruction decoder: prefixes, REX/VEX, ModRM/SIB, immediate reads,
// and the irregular-opcode custom handlers. Output is syntax-neutral
// (structured operands); render.ts turns it into AT&T or Intel text.

import {
  gprName, vecName, GPR64, GPR32, GPR16, GPR8, XMM, YMM, SEG,
  type MemOp, type ModRM, type Prefixes, type Rex, type Sib, type VexInfo, type X64Width,
} from './regs';
import { OP1, OP2, OP38, OP3A, type OpEntry, type OperandSpec } from './opref';
import { F3_PREFIX_OVERRIDE } from './tables';
import { SSE_PREFIX_OVERRIDE } from './sse';
import type { Bytes, FlowType, Instruction, Operand } from '../types';

export class DecodeError extends Error {}

interface DecodeCtx {
  bytes: Uint8Array;
  pos: number;
  start: number;
  addr: number;
  pre: Prefixes;
  opSize: 16 | 32 | 64;
}

const noRex: Rex = { present: false, w: false, r: false, x: false, b: false };

function u8(c: DecodeCtx): number {
  if (c.pos >= c.bytes.length) throw new DecodeError('truncated instruction');
  return c.bytes[c.pos++];
}
function u16(c: DecodeCtx): number {
  return u8(c) | (u8(c) << 8);
}
function u32(c: DecodeCtx): number {
  return (u8(c) | (u8(c) << 8) | (u8(c) << 16) | (u8(c) << 24)) >>> 0;
}
function i8(c: DecodeCtx): number {
  return (u8(c) << 24) >> 24;
}
function i32(c: DecodeCtx): number {
  return u32(c) | 0;
}
function immBytes(c: DecodeCtx, width: 8 | 16 | 32 | 64, sign: 'u' | 's'): bigint {
  let v = 0n;
  const n = width / 8;
  for (let i = 0; i < n; i++) v |= BigInt(u8(c)) << BigInt(i * 8);
  // Keep the raw bit pattern; the renderers decide how to display it.
  // Relative offsets still want signed values, handled by the callers.
  void sign;
  return v;
}

function signed(v: bigint, width: number): bigint {
  if (v & (1n << BigInt(width - 1))) return v - (1n << BigInt(width));
  return v;
}

function scanPrefixes(c: DecodeCtx): number {
  c.pre = { rex: noRex, opsize: false, addrsize: false, seg: -1, rep: 0, lock: false };
  let opcode = 0;
  for (;;) {
    const b = u8(c);
    if (b >= 0x40 && b <= 0x4f) {
      c.pre.rex = { present: true, w: !!(b & 8), r: !!(b & 4), x: !!(b & 2), b: !!(b & 1) };
      opcode = u8(c);
      break;
    }
    if (b === 0x66) { c.pre.opsize = true; continue; }
    if (b === 0x67) { c.pre.addrsize = true; continue; }
    if (b === 0xf2 || b === 0xf3) { c.pre.rep = b; continue; }
    if (b === 0xf0) { c.pre.lock = true; continue; }
    if (b >= 0x26 && b <= 0x36 && (b === 0x26 || b === 0x2e || b === 0x36 || b === 0x3e || b === 0x64 || b === 0x65)) {
      c.pre.seg = b;
      continue;
    }
    if (b === 0xc4 || b === 0xc5) {
      c.pre.vex = decodeVex(c, b);
      opcode = u8(c);
      break;
    }
    opcode = b;
    break;
  }
  return opcode;
}

function decodeVex(c: DecodeCtx, first: number): VexInfo {
  if (first === 0xc5) {
    const p = u8(c);
    return {
      bytes: 2,
      vecLen: (p & 4) ? 256 : 128,
      map: 1,
      r: !(p & 0x80), x: true, b: true,
      vvvv: (~(p >> 3) & 0xf),
      w: false,
      pp: p & 3,
    };
  }
  const p1 = u8(c);
  const p2 = u8(c);
  const mapBits = p1 & 0x1f;
  return {
    bytes: 3,
    vecLen: (p2 & 4) ? 256 : 128,
    map: mapBits === 1 ? 1 : mapBits === 2 ? 2 : 3,
    r: !(p1 & 0x80), x: !(p1 & 0x40), b: !(p1 & 0x20),
    vvvv: (~(p2 >> 3) & 0xf),
    w: !!(p2 & 0x80),
    pp: p2 & 3,
  };
}

/** Resolve effective GPR width for an entry given prefix/REX state. */
function effWidth(entry: OpEntry, c: DecodeCtx, specWidth: X64Width | 'v' | 'm'): X64Width {
  if (specWidth === 'm') return entry.defW === 8 ? 8 : c.pre.rex.w ? 64 : c.pre.opsize ? 16 : 32;
  if (specWidth !== 'v') {
    // Explicit width still yields to 0x66 for 16-bit operation and REX.W for 64.
    if (specWidth === 32 && c.pre.opsize) return 16;
    return specWidth;
  }
  if (entry.rexW64 === false) {
    // byte/vector ops: REX.W ignored; 0x66 gives 16 for GPR widths
    if (entry.defW === 8) return 8;
    return c.pre.opsize ? 16 : 32;
  }
  if (c.pre.rex.w) return 64;
  if (c.pre.opsize) return 16;
  return entry.defW === 64 ? 64 : 32;
}

function readModRM(c: DecodeCtx): ModRM {
  const raw = u8(c);
  const rexR = c.pre.vex ? (c.pre.vex.r ? 8 : 0) : c.pre.rex.r ? 8 : 0;
  const rexB = c.pre.vex ? (c.pre.vex.b ? 8 : 0) : c.pre.rex.b ? 8 : 0;
  return { mod: raw >> 6, reg: ((raw >> 3) & 7) | rexR, rm: (raw & 7) | rexB, raw };
}

function readSib(c: DecodeCtx): Sib {
  const raw = u8(c);
  const rexX = c.pre.vex ? (c.pre.vex.x ? 8 : 0) : c.pre.rex.x ? 8 : 0;
  const rexB = c.pre.vex ? (c.pre.vex.b ? 8 : 0) : c.pre.rex.b ? 8 : 0;
  return {
    scale: 1 << (raw >> 6),
    index: ((raw >> 3) & 7) | rexX,
    base: (raw & 7) | rexB,
    raw,
  };
}

interface DecodedMem {
  mem: MemOp;
  /** true when mod=0 r/m=5: RIP-relative */
  ripRel: boolean;
}

function decodeMem(c: DecodeCtx, modrm: ModRM, width: X64Width): DecodedMem {
  const disp: bigint = 0n;
  if (modrm.mod === 3) throw new DecodeError('register operand passed to decodeMem');
  const mem: MemOp = { disp: 0n, width };

  // RIP-relative: mod=0, rm=5
  if (modrm.mod === 0 && (modrm.rm & 7) === 5) {
    const d = BigInt(i32(c));
    const ripTarget = c.addr + (c.pos - c.start) + Number(d);
    return { ripRel: true, mem: { ...mem, disp: d, ripTarget, base: 'rip' } };
  }
  if ((modrm.rm & 7) === 4) {
    const sib = readSib(c);
    if (sib.index !== 4) mem.index = GPR64[sib.index];
    mem.scale = sib.scale;
    if ((sib.base & 7) === 5 && modrm.mod === 0) {
      mem.disp = BigInt(i32(c));
      // no base register
    } else {
      mem.base = GPR64[sib.base];
    }
  } else {
    mem.base = GPR64[modrm.rm];
  }
  if (modrm.mod === 1) mem.disp = BigInt(i8(c));
  else if (modrm.mod === 2 || ((modrm.rm & 7) === 5 && modrm.mod === 0 && modrm.rm === 5)) {
    // mod=2 disp32 (the rm==5 mod==0 case already returned above for RIP;
    // SIB-no-base disp32 was consumed in SIB branch)
    if (modrm.mod === 2) mem.disp = BigInt(i32(c));
  }
  // special: SIB base=5 mod=0 already handled; disp-only remains base-less
  return { ripRel: false, mem };
}

function regOperand(c: DecodeCtx, idx: number, width: X64Width, vector: boolean): Operand {
  if (vector) {
    const name = width === 256 || (c.pre.vex?.vecLen === 256) ? YMM[idx] : XMM[idx];
    return { kind: 'fp-reg', reg: name };
  }
  return { kind: 'reg', reg: gprName(width, idx, c.pre.rex.present) };
}

function decodeOperands(c: DecodeCtx, entry: OpEntry, modrm: ModRM | null, relTarget: (rel: number) => number): Operand[] {
  const out: Operand[] = [];
  for (const spec of entry.operands) {
    out.push(decodeOne(c, entry, spec, modrm, relTarget));
  }
  return out;
}

function decodeOne(
  c: DecodeCtx,
  entry: OpEntry,
  spec: OperandSpec,
  modrm: ModRM | null,
  relTarget: (rel: number) => number,
): Operand {
  switch (spec.kind) {
    case 'r': {
      const w = effWidth(entry, c, spec.width);
      return regOperand(c, modrm!.reg, w, !!entry.vector);
    }
    case 'xmm-r':
      return { kind: 'fp-reg', reg: c.pre.vex ? vecName(c.pre.vex.vecLen, modrm!.reg) : XMM[modrm!.reg] };
    case 'ymm-r':
      return { kind: 'fp-reg', reg: YMM[modrm!.reg] };
    case 'rm':
    case 'xmm-rm':
    case 'ymm-rm': {
      const m = modrm!;
      if (m.mod === 3) {
        if (spec.kind === 'ymm-rm' || spec.kind === 'xmm-rm' || entry.vector) {
          const w: X64Width = c.pre.vex?.vecLen ?? 128;
          return regOperand(c, m.rm, w, true);
        }
        const w = effWidth(entry, c, spec.width);
        return regOperand(c, m.rm, w, false);
      }
      const w: X64Width = spec.kind === 'rm' ? effWidth(entry, c, spec.width) : (c.pre.vex?.vecLen ?? 128);
      const { mem } = decodeMem(c, m, w);
      return { kind: 'mem', mem: { base: mem.base, index: mem.index, scale: mem.scale, disp: mem.disp, ripTarget: mem.ripTarget, width: w } };
    }
    case 'imm': {
      const v = immBytes(c, spec.width, spec.sign);
      // Negative 8-bit immediates are rendered with the sign (e.g. $-0x1);
      // wider values keep their unsigned bit pattern (0xffffffff style).
      if (spec.width === 8 && spec.sign === 's') {
        return { kind: 'imm', imm: signed(v, 8) };
      }
      return { kind: 'imm', imm: v };
    }
    case 'imm-rel': {
      const rel = spec.width === 8 ? i8(c) : spec.width === 16 ? (i16(c)) : i32(c);
      const target = relTarget(rel);
      return { kind: 'imm', imm: BigInt(target) };
    }
    case 'imm-ptr': {
      const sel = u16(c);
      const off = u32(c);
      return { kind: 'imm', imm: BigInt(off) | (BigInt(sel) << 32n) };
    }
    case 'al': return { kind: 'reg', reg: 'al' };
    case 'cl': return { kind: 'reg', reg: 'cl' };
    case 'ax': return { kind: 'reg', reg: 'ax' };
    case 'eax':
      return { kind: 'reg', reg: c.pre.rex.w ? GPR64[0] : c.pre.opsize ? GPR16[0] : GPR32[0] };
    case 'rax': return { kind: 'reg', reg: GPR64[0] };
    case 'dx': return { kind: 'reg', reg: 'dx' };
    case '1': return { kind: 'imm', imm: 1n };
    case 'moffs': {
      const off = spec.width === 64 ? BigInt(u32(c) | 0) : BigInt(u32(c) >>> 0);
      return { kind: 'mem', mem: { disp: off } };
    }
  }
}

function i16(c: DecodeCtx): number {
  const v = u16(c);
  return (v << 16) >> 16;
}

// ---------------- custom handlers ----------------

interface CustomResult {
  mnemonic: string;
  operands: Operand[];
  flow: FlowType;
  target?: number;
  widthSuffix?: '' | 'b' | 'w' | 'l' | 'q' | 's' | 'd' | 't';
  /** indirect branch/call target requiring the AT&T '*' sigil */
  indirect?: boolean;
}

function custom(c: DecodeCtx, name: string, entry: OpEntry, modrm: ModRM | null, opcode: number): CustomResult {
  const relTarget = (rel: number) => c.addr + (c.pos - c.start) + rel;
  switch (name) {
    case 'push-pop-r': {
      const idx = (opcode & 7) | (c.pre.rex.b ? 8 : 0);
      return {
        mnemonic: opcode >= 0x58 ? 'popq' : 'pushq',
        operands: [{ kind: 'reg', reg: GPR64[idx] }],
        flow: 'normal',
        widthSuffix: '',
      };
    }
    case 'push-imm': {
      const isImm8 = entry.operands[0]?.kind === 'imm' && (entry.operands[0] as { width: number }).width === 8;
      const v = isImm8 ? signed(immBytes(c, 8, 's'), 8) : immBytes(c, 32, 'u');
      return { mnemonic: 'pushq', operands: [{ kind: 'imm', imm: v }], flow: 'normal', widthSuffix: '' };
    }
    case 'xchg-nop': {
      const idx = (opcode & 7) | (c.pre.rex.b ? 8 : 0);
      // 0x90 is always NOP (with or without 0x66); objdump prints plain "nop"
      // for both 90 and 66 90.
      if (idx === 0 && !c.pre.rex.present) {
        return { mnemonic: 'nop', operands: [], flow: 'normal', widthSuffix: '' };
      }
      return {
        mnemonic: 'xchg',
        operands: [{ kind: 'reg', reg: GPR64[idx] }, { kind: 'reg', reg: GPR64[0] }],
        flow: 'normal', widthSuffix: 'q',
      };
    }
    case 'cwde':
      return { mnemonic: c.pre.rex.w ? 'cltq' : 'cwde', operands: [], flow: 'normal', widthSuffix: '' };
    case 'cdq':
      return { mnemonic: c.pre.rex.w ? 'cqto' : 'cltd', operands: [], flow: 'normal', widthSuffix: '' };
    case 'string-op': {
      // width suffix and 0x66 switching handled by renderer via mnemonic base
      return { mnemonic: entry.m, operands: [], flow: 'normal', widthSuffix: c.pre.opsize ? 'w' : c.pre.rex.w ? 'q' : 'l' };
    }
    case 'mov-imm-r': {
      const idx = (opcode & 7) | (c.pre.rex.b ? 8 : 0);
      const is8 = opcode < 0xb8;
      if (is8) {
        const v = signed(immBytes(c, 8, 's'), 8);
        return { mnemonic: 'mov', operands: [{ kind: 'reg', reg: gprName(8, idx, c.pre.rex.present) }, { kind: 'imm', imm: v }], flow: 'normal', widthSuffix: 'b' };
      }
      if (c.pre.rex.w) {
        const v = immBytes(c, 64, 's');
        return { mnemonic: 'mov', operands: [{ kind: 'reg', reg: GPR64[idx] }, { kind: 'imm', imm: v }], flow: 'normal', widthSuffix: 'q' };
      }
      const v = immBytes(c, 32, 'u');
      return {
        mnemonic: 'mov',
        operands: [{ kind: 'reg', reg: c.pre.opsize ? GPR16[idx] : GPR32[idx] }, { kind: 'imm', imm: v }],
        flow: 'normal', widthSuffix: c.pre.opsize ? 'w' : 'l',
      };
    }
    case 'ret-imm': {
      const v = immBytes(c, 16, 'u');
      return { mnemonic: entry.m, operands: [{ kind: 'imm', imm: v }], flow: 'return', widthSuffix: 'q' };
    }
    case 'enter': {
      const size = immBytes(c, 16, 'u');
      const level = immBytes(c, 8, 'u');
      return { mnemonic: 'enter', operands: [{ kind: 'imm', imm: size }, { kind: 'imm', imm: level }], flow: 'normal' };
    }
    case 'int3':
      return { mnemonic: 'int3', operands: [], flow: 'normal', widthSuffix: '' };
    case 'ud2':
      return { mnemonic: 'ud2', operands: [], flow: 'normal' };
    case 'jrcxz':
      return { mnemonic: c.pre.addrsize ? 'jecxz' : 'jrcxz', operands: decodeOperands(c, entry, modrm, relTarget), flow: 'conditional-jump' as FlowType, target: Number(decodeOperands(c, entry, modrm, relTarget)[0].imm) };
    case 'shift-imm':
    case 'shift-cl': {
      const SHIFT = ['rol', 'ror', 'rcl', 'rcr', 'shl', 'shr', 'sal', 'sar'];
      const m = SHIFT[modrm!.reg];
      const w = effWidth(entry, c, 'v');
      const suffix = w === 8 ? 'b' : w === 16 ? 'w' : w === 64 ? 'q' : 'l';
      const memOrReg = decodeOne(c, entry, entry.operands[0], modrm, relTarget);
      const cnt = name === 'shift-imm'
        ? decodeOne(c, entry, entry.operands[1], modrm, relTarget)
        : { kind: 'reg' as const, reg: 'cl' };
      return { mnemonic: m, operands: [memOrReg, cnt], flow: 'normal', widthSuffix: suffix };
    }
    case 'group1-8':
    case 'group1-32': {
      const NAMES = ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp'];
      const m = NAMES[modrm!.reg];
      const w = name === 'group1-8' && opcode === 0x80 ? 8 : effWidth(entry, c, 'v');
      const suffix = w === 8 ? 'b' : w === 16 ? 'w' : w === 64 ? 'q' : 'l';
      const dst = decodeOne(c, entry, entry.operands[0], modrm, relTarget);
      const immSpec = entry.operands[1] as Extract<OperandSpec, { kind: 'imm' }>;
      // 0x83 sign-extends imm8; 0x81 uses imm32 (or imm16 with 0x66)
      // 0x83 sign-extends imm8 (rendered signed); 0x81 uses raw imm32/imm16.
      const immW = opcode === 0x83 ? 8 : opcode === 0x81 ? (c.pre.opsize ? 16 : 32) : 8;
      const rawImm = immBytes(c, immW, 's');
      const imm = { kind: 'imm' as const, imm: immW === 8 ? signed(rawImm, 8) : rawImm };
      return { mnemonic: m, operands: [dst, imm], flow: 'normal', widthSuffix: suffix };
    }
    case 'group-pop': {
      if (modrm!.reg !== 0) throw new DecodeError(`bad /${modrm!.reg} for 8F`);
      const dst = decodeOne(c, entry, entry.operands[0], modrm, relTarget);
      return { mnemonic: 'pop', operands: [dst], flow: 'normal', widthSuffix: 'q' };
    }
    case 'group3': {
      const sub = modrm!.reg;
      const w = opcode === 0xf6 ? 8 : effWidth(entry, c, 'v');
      const suffix = w === 8 ? 'b' : w === 16 ? 'w' : w === 64 ? 'q' : 'l';
      const dst = decodeOne(c, { ...entry, defW: w }, entry.operands[0], modrm, relTarget);
      if (sub === 0 || sub === 1) {
        const raw = immBytes(c, w === 8 ? 8 : 32, 's');
        const imm = { kind: 'imm' as const, imm: w === 8 ? signed(raw, 8) : raw };
        return { mnemonic: 'test', operands: [dst, imm], flow: 'normal', widthSuffix: suffix };
      }
      const NAMES = ['', '', 'not', 'neg', 'mul', 'imul', 'div', 'idiv'];
      return { mnemonic: NAMES[sub], operands: [dst], flow: 'normal', widthSuffix: suffix };
    }
    case 'group4': {
      const NAMES = ['inc', 'dec'];
      const dst = decodeOne(c, entry, entry.operands[0], modrm, relTarget);
      return { mnemonic: NAMES[modrm!.reg], operands: [dst], flow: 'normal', widthSuffix: 'b' };
    }
    case 'group5': {
      const sub = modrm!.reg;
      const dst = decodeOne(c, entry, entry.operands[0], modrm, relTarget);
      if (sub <= 1) {
        return { mnemonic: sub === 0 ? 'inc' : 'dec', operands: [dst], flow: 'normal', widthSuffix: c.pre.rex.w ? 'q' : c.pre.opsize ? 'w' : 'l' };
      }
      if (sub === 2 || sub === 3) {
        const target64: Operand = dst.kind === 'reg' ? { kind: 'reg', reg: GPR64[modrm!.rm & 15] } : dst;
        return { mnemonic: 'callq', operands: [target64], flow: 'call', indirect: true };
      }
      if (sub === 4) {
        // FF /4 is an indirect jmp in 64-bit mode; operand is always 64-bit.
        const target64: Operand = dst.kind === 'reg' ? { kind: 'reg', reg: GPR64[modrm!.rm & 15] } : dst;
        return { mnemonic: 'jmpq', operands: [target64], flow: 'indirect-jump', target: undefined, indirect: true };
      }
      if (sub === 6) return { mnemonic: 'pushq', operands: [dst], flow: 'normal', widthSuffix: '' };
      throw new DecodeError(`bad group5 /${sub}`);
    }
    case 'group8': {
      const NAMES = ['', '', '', '', 'bt', 'bts', 'btr', 'btc'];
      const m = NAMES[modrm!.reg];
      const dst = decodeOne(c, entry, entry.operands[0], modrm, relTarget);
      const imm = decodeOne(c, entry, entry.operands[1], modrm, relTarget);
      return { mnemonic: m, operands: [dst, imm], flow: 'normal', widthSuffix: c.pre.rex.w ? 'q' : 'l' };
    }
    case 'group15': {
      // 0F AE /0..7: fxsave/fxrstor/stmxcsr/ldmxcsr/(reserved)/lfence/mfence/clflush...
      const sub = modrm!.reg;
      const NAMES = ['fxsave64', 'fxrstor64', 'ldmxcsr', 'stmxcsr', '', 'lfence', 'mfence', 'clflush'];
      if (sub === 5 || sub === 6) return { mnemonic: NAMES[sub], operands: [], flow: 'normal' };
      const dst = decodeOne(c, entry, entry.operands[0], modrm, relTarget);
      if (sub === 7) return { mnemonic: 'sfence', operands: [], flow: 'normal' };
      return { mnemonic: NAMES[sub] || 'nop', operands: sub === 4 ? [] : [dst], flow: 'normal' };
    }
    case 'bswap': {
      const idx = (opcode & 7) | (c.pre.rex.b ? 8 : 0);
      return { mnemonic: 'bswap', operands: [{ kind: 'reg', reg: GPR64[idx] }], flow: 'normal', widthSuffix: 'q' };
    }
    case 'movzx':
    case 'movsx': {
      const dst = regOperand(c, modrm!.reg, c.pre.rex.w ? 64 : 32, false);
      const src = decodeOne(c, entry, entry.operands[1], modrm, relTarget);
      return { mnemonic: entry.m, operands: [dst, src], flow: 'normal' };
    }
    case 'mov-sys':
    case 'mov-sys-dr': {
      const sysRegs = ['cr0', 'cr2', 'cr3', 'cr4', 'cr8', 'cr8', 'cr8', 'cr8'];
      const reg = sysRegs[modrm!.reg] ?? `cr${modrm!.reg}`;
      const gpr = regOperand(c, modrm!.rm, 64, false);
      // /0 mov r,CR; /2 mov CR,r; /4 etc. DR similarly
      const toSys = (modrm!.reg & 4) !== 0;
      return {
        mnemonic: 'mov',
        operands: toSys ? [gpr, { kind: 'sysreg', reg }] : [{ kind: 'sysreg', reg }, gpr],
        flow: 'normal', widthSuffix: 'q',
      };
    }
    case 'push-seg':
      return { mnemonic: 'push', operands: [{ kind: 'sysreg', reg: SEG[opcode - 0xa0] }], flow: 'normal' };
    case 'pop-seg':
      return { mnemonic: 'pop', operands: [{ kind: 'sysreg', reg: SEG[opcode - 0xa1] }], flow: 'normal' };
    case 'push-seg-gs':
      return { mnemonic: 'push', operands: [{ kind: 'sysreg', reg: 'gs' }], flow: 'normal' };
    case 'pop-seg-gs':
      return { mnemonic: 'pop', operands: [{ kind: 'sysreg', reg: 'gs' }], flow: 'normal' };
    case 'nop-modrm': {
      // Multi-byte NOP: 0x66 prefix selects nopw, otherwise nopl in 64-bit mode.
      const mn = c.pre.opsize ? 'nopw' : 'nopl';
      return { mnemonic: mn, operands: modrm!.mod === 3 ? [] : [decodeOne(c, entry, entry.operands[0], modrm, relTarget)], flow: 'normal' };
    }
    case 'emms':
      return { mnemonic: c.pre.opsize ? 'movq' : 'emms', operands: c.pre.opsize ? decodeOperands(c, entry, modrm, relTarget) : [], flow: 'normal' };
    case 'x87':
      return decodeX87(c, opcode, modrm);
    case 'far-ptr':
      throw new DecodeError('far jump/call unsupported in 64-bit mode');
  }
  // SSE entries carry custom = "sse:<flavor>"
  if (name.startsWith('sse:')) {
    const ops = decodeOperands(c, entry, modrm, relTarget);
    if (entry.operands.some((o) => o.kind === 'imm')) {
      // last operand already consumed
    }
    return { mnemonic: entry.m, operands: ops, flow: 'normal' };
  }
  throw new DecodeError(`unhandled custom ${name}`);
}

// Minimal x87: compiler output in modern firmware is limited to float loads/stores
// and compares; render the common encodings, mark anything else as fwait-group raw.
function decodeX87(c: DecodeCtx, opcode: number, modrm: ModRM | null): CustomResult {
  if (!modrm || modrm.mod === 3) {
    const fn = ['fadd', 'fmul', 'fcom', 'fcomp', 'fsub', 'fsubr', 'fdiv', 'fdivr'];
    if (opcode >= 0xd8 && opcode <= 0xde && modrm && modrm.mod === 3) {
      return { mnemonic: `${fn[opcode - 0xd8]}s`, operands: [{ kind: 'fp-reg', reg: `st${modrm.rm}` }], flow: 'normal' };
    }
    if (opcode === 0xdd && modrm && modrm.mod === 3 && modrm.reg < 4) {
      return { mnemonic: 'ffree', operands: [{ kind: 'fp-reg', reg: `st${modrm.rm}` }], flow: 'normal' };
    }
    return { mnemonic: '(x87)', operands: [], flow: 'normal' };
  }
  const mem = decodeOne(c, { m: '', operands: [], defW: 32 } as OpEntry, { kind: 'rm', width: 32, pos: 0 }, modrm, () => 0);
  const loadStore: Record<number, string[]> = {
    0xd8: ['fadds', 'fmuls', 'fcoms', 'fcomps', 'fsubs', 'fsubrs', 'fdivs', 'fdivrs'],
    0xd9: ['flds', 'fld?', 'fst?', 'fsts', 'fldenv', 'fldcw', 'fnstenv', 'fnstcw'],
    0xda: ['fiaddl', 'fimull', 'ficoml', 'ficompl', 'fisubl', 'fisubrl', 'fidivl', 'fidivrl'],
    0xdb: ['fildl', 'fisttp', 'fistl', 'fistpl', '', '', 'fldt', 'fstpt'],
    0xdc: ['faddl', 'fmull', 'fcoml', 'fcompl', 'fsubl', 'fsubl', 'fdivl', 'fdivrl'],
    0xdd: ['fldl', 'fisttpl', 'fstl', 'fstpl', '', '', '', ''],
    0xde: ['fiaddw', 'fimulw', 'ficomw', 'ficompw', 'fisubw', 'fisubrw', 'fidivw', 'fidivrw'],
    0xdf: ['fildw', 'fisttpw', 'fistw', 'fistpw', 'fildq', 'fisttpq', 'fistpq', 'fistpq'],
  };
  const names = loadStore[opcode];
  const m = names?.[modrm!.reg] ?? '(x87)';
  return { mnemonic: m, operands: [mem], flow: 'normal' };
}

// ---------------- main entry ----------------

export interface DecodeOptions {
  syntax: 'att' | 'intel';
}

export function decodeInstruction(bytes: Bytes, addr: number, opts: DecodeOptions): Instruction {
  const c: DecodeCtx = {
    bytes, pos: 0, start: 0, addr,
    pre: { rex: noRex, opsize: false, addrsize: false, seg: -1, rep: 0, lock: false },
    opSize: 32,
  };
  let entry: OpEntry | undefined;
  let modrm: ModRM | null = null;
  let customRes: CustomResult | null = null;
  let invalid = false;

  try {
    const firstOp = scanPrefixes(c);
    let opcode = firstOp;
    let table = OP1;
    if (opcode === 0x0f) {
      const next = u8(c);
      if (next === 0x38) {
        opcode = u8(c);
        table = OP38;
      } else if (next === 0x3a) {
        opcode = u8(c);
        table = OP3A;
      } else {
        opcode = next;
        table = OP2;
        // F3-prefixed popcnt/tzcnt/lzcnt
        if (c.pre.rep === 0xf3 && F3_PREFIX_OVERRIDE[opcode]) {
          // fall through; mnemonic patched after entry fetch
        }
        // SSE prefix override (66/F2/F3 + 0F xx)
        const pfx = c.pre.opsize ? 0x66 : c.pre.rep;
        if (pfx && SSE_PREFIX_OVERRIDE[(pfx << 8) | opcode]) {
          const ov = SSE_PREFIX_OVERRIDE[(pfx << 8) | opcode];
          const base = OP2[opcode];
          if (base) {
            entry = { ...base, m: ov.m, custom: `sse:${ov.flavor}` };
          }
        }
      }
    }
    if (!entry) entry = table[opcode];
    if (!entry) {
      invalid = true;
      entry = { m: '.byte', operands: [], defW: 8 };
    }
    if (c.pre.rep === 0xf3 && table === OP2 && F3_PREFIX_OVERRIDE[opcode]) {
      entry = { ...entry, m: F3_PREFIX_OVERRIDE[opcode], custom: 'f3-gpr' };
    }

    // Does this instruction need ModRM? Entries whose custom handler reads
    // ModRM explicitly are listed; push-pop/imm/xchg etc. encode their operand
    // in the opcode and must NOT consume the next byte as ModRM.
    const MODRM_CUSTOM = new Set([
      'shift-imm', 'shift-cl', 'group1-8', 'group1-32', 'group-pop', 'group3',
      'group4', 'group5', 'group8', 'group15', 'nop-modrm', 'x87',
      'movzx', 'movsx', 'mov-sys', 'mov-sys-dr',
    ]);
    const needsModRM = entry.operands.some((o) =>
      o.kind === 'r' || o.kind === 'rm' || o.kind === 'xmm-r' || o.kind === 'xmm-rm' || o.kind === 'ymm-r' || o.kind === 'ymm-rm')
      || (entry.custom !== undefined && (MODRM_CUSTOM.has(entry.custom) || entry.custom.startsWith('sse:')))
      || (entry.custom === 'emms' && c.pre.opsize);
    if (needsModRM && !invalid) modrm = readModRM(c);

    const relTarget = (rel: number) => c.addr + (c.pos - c.start) + rel;
    let mnemonic: string;
    let operands: Operand[];
    let flow: FlowType = 'normal';
    let target: number | undefined;
    let widthSuffix: CustomResult['widthSuffix'];
    let indirect = false;

    if (entry.custom && !invalid) {
      customRes = custom(c, entry.custom, entry, modrm, opcode);
      mnemonic = customRes.mnemonic;
      operands = customRes.operands;
      flow = customRes.flow;
      target = customRes.target;
      widthSuffix = customRes.widthSuffix;
      indirect = customRes.indirect ?? false;
    } else if (!invalid) {
      operands = decodeOperands(c, entry, modrm, relTarget);
      mnemonic = entry.m;
      widthSuffix = defaultSuffix(entry, c, operands);
      if (entry.flow === 'call') {
        flow = 'call';
        target = Number(operands[0]?.imm);
      } else if (entry.flow === 'jmp') {
        flow = 'conditional-jump' as FlowType; // overwritten below for unconditional
        target = Number(operands[0]?.imm);
        flow = mnemonic === 'jmp' ? 'direct-jump' : 'conditional-jump';
      } else if (entry.flow === 'jcc') {
        flow = 'conditional-jump';
        target = Number(operands[0]?.imm);
      } else if (entry.flow === 'ret') {
        flow = 'return';
      } else if (entry.flow === 'sys') {
        flow = 'syscall';
      }
    } else {
      mnemonic = '.byte';
      operands = [{ kind: 'imm', imm: BigInt(bytes[0]) }];
      c.pos = 1;
    }

    const raw = bytes.subarray(0, Math.max(1, c.pos));
    const text = render(mnemonic, operands, opts.syntax, widthSuffix, c, indirect);
    return {
      addr,
      bytes: raw,
      mnemonic,
      opStr: text.opStr,
      text: text.full,
      comment: '',
      operands,
      flow,
      target,
      invalid,
    };
  } catch (e) {
    const raw = bytes.subarray(0, Math.max(1, Math.min(c.pos, 15)));
    return {
      addr, bytes: raw, mnemonic: '.byte', opStr: '', text: '.byte', comment: `decode error: ${(e as Error).message}`,
      operands: [{ kind: 'imm', imm: BigInt(bytes[0] ?? 0) }], flow: 'normal', invalid: true,
    };
  }
}

/** Derive the AT&T width suffix from the decoded operands when the entry
 *  didn't pin one. All width-bearing operands of a valid instruction agree;
 *  the smallest width class present is authoritative (imm values excluded). */
function suffixFromOperands(operands: Operand[]): CustomResult['widthSuffix'] {
  const R16 = new Set(['ax', 'cx', 'dx', 'bx', 'sp', 'bp', 'si', 'di']);
  const R8H = new Set(['al', 'cl', 'dl', 'bl', 'spl', 'bpl', 'sil', 'dil', 'ah', 'ch', 'dh', 'bh']);
  const ranks: X64Width[] = [];
  for (const op of operands) {
    if (op.kind === 'reg') {
      const r = op.reg!;
      if (/^r\d+$/.test(r) || ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi'].includes(r)) ranks.push(64);
      else if (r.endsWith('d')) ranks.push(32);
      else if (r.endsWith('w') || R16.has(r)) ranks.push(16);
      else if (R8H.has(r) || r.endsWith('b')) ranks.push(8);
    } else if (op.kind === 'mem' && op.mem?.width) {
      ranks.push(op.mem.width as X64Width);
    }
  }
  if (ranks.length === 0) return 'l';
  const width = Math.min(...ranks) as X64Width;
  if (width === 64) return 'q';
  if (width === 16) return 'w';
  if (width === 8) return 'b';
  return 'l';
}

function defaultSuffix(entry: OpEntry, c: DecodeCtx, operands?: Operand[]): CustomResult['widthSuffix'] {
  if (entry.vector) return undefined;
  // Explicit byte-width entries always get 'b' regardless of operand shapes.
  if (entry.defW === 8 && entry.rexW64 === false) return 'b';
  if (operands && operands.some((o) => o.kind === 'reg' || o.kind === 'mem')) {
    // The decoded memory/register width already accounts for 0x66 and REX.W.
    const fromOps = suffixFromOperands(operands);
    // Memory-only operands (mov mem,imm / mov mem,reg) carry the authoritative width.
    if (operands.some((o) => o.kind === 'mem')) return fromOps;
    return fromOps;
  }
  if (entry.rexW64 === false && entry.defW !== 64) return c.pre.opsize ? 'w' : 'l';
  if (c.pre.rex.w) return 'q';
  if (c.pre.opsize) return 'w';
  return entry.defW === 64 ? 'q' : 'l';
}

/** Mnemonics that already encode their width (movsbl/movslq/movzbl...). */
const WIDTH_BUILTIN = new Set(['movsbl', 'movswl', 'movslq', 'movzbl', 'movzwl', 'movzbq', 'movzwq']);

// ---------------- rendering ----------------

function render(
  mnemonic: string,
  operands: Operand[],
  syntax: 'att' | 'intel',
  suffix: CustomResult['widthSuffix'],
  c: DecodeCtx,
  indirect = false,
): { opStr: string; full: string } {
  if (syntax === 'att') return renderAtt(mnemonic, operands, suffix, c, indirect);
  return renderIntel(mnemonic, operands, c);
}

function widthPrefixForMem(op: Operand): string {
  if (op.kind !== 'mem') return '';
  const w = op.mem?.width;
  if (w === 8) return 'BYTE PTR ';
  if (w === 16) return 'WORD PTR ';
  if (w === 32) return 'DWORD PTR ';
  if (w === 64) return 'QWORD PTR ';
  if (w === 128) return 'XMMWORD PTR ';
  if (w === 256) return 'YMMWORD PTR ';
  return '';
}

function intelMnemonic(mn: string): string {
  // Intel syntax drops AT&T size suffixes from branches and opcodes.
  if (mn === 'jmpq' || mn === 'jmp') return 'jmp';
  if (mn === 'callq' || mn === 'call') return 'call';
  if (mn === 'retq') return 'ret';
  if (mn.endsWith('q') || mn.endsWith('l') || mn.endsWith('w') || mn.endsWith('b')) {
    // Only strip the width suffix from GPR opcodes, not names that legitimately
    // end in those letters (the table mnemonics are all suffix-form GPR/SSE ops).
    return mn.slice(0, -1);
  }
  return mn;
}

function renderIntel(mnemonic: string, operands: Operand[], c: DecodeCtx): { opStr: string; full: string } {
  const intelMn = intelMnemonic(mnemonic);
  const parts = operands.map((op) => {
    if (op.kind === 'reg' || op.kind === 'fp-reg' || op.kind === 'sysreg') return op.reg!;
    if (op.kind === 'imm') return formatImmIntel(op.imm!);
    const m = op.mem!;
    const inner: string[] = [];
    if (m.base) inner.push(m.base);
    if (m.index) inner.push(`${m.index}${m.scale && m.scale !== 1 ? `*${m.scale}` : ''}`);
    let body = inner.join('+');
    if (m.disp !== undefined && m.disp !== 0n || inner.length === 0) {
      const d = m.disp ?? 0n;
      const ds = d < 0n ? `-0x${(-d).toString(16)}` : `0x${d.toString(16)}`;
      body = body ? `${body}${d < 0n ? '-' : '+'}${ds.replace(/^[+-]/, '')}` : ds;
    }
    const seg = c.pre.seg >= 0 ? `${SEG_GUARD[c.pre.seg]}:` : '';
    return `${widthPrefixForMem(op)}${seg}[${body}]`;
  }).join(', ');
  // Operand arrays already hold Intel dest-first order.
  const ordered = operands;
  const opStr = ordered.map((op) => {
    if (op.kind === 'reg' || op.kind === 'fp-reg' || op.kind === 'sysreg') return op.reg!;
    if (op.kind === 'imm') return formatImmIntel(op.imm!);
    const m = op.mem!;
    const inner: string[] = [];
    if (m.base) inner.push(m.base);
    if (m.index) inner.push(`${m.index}${m.scale && m.scale !== 1 ? `*${m.scale}` : ''}`);
    let body = inner.join('+');
    if ((m.disp !== undefined && m.disp !== 0n) || inner.length === 0) {
      const d = m.disp ?? 0n;
      const ds = d < 0n ? `-0x${(-d).toString(16)}` : `0x${d.toString(16)}`;
      body = body ? `${body}${d < 0n ? '-' : '+'}${ds.replace(/^[+-]/, '')}` : ds;
    }
    const seg = c.pre.seg >= 0 ? `${SEG_GUARD[c.pre.seg]}:` : '';
    return `${widthPrefixForMem(op)}${seg}[${body}]`;
  }).join(', ');
  const lock = c.pre.lock ? 'lock ' : '';
  const rep = c.pre.rep ? `${c.pre.rep === 0xf3 ? 'rep ' : 'repne '}` : '';
  const full = `${lock}${rep}${intelMn}${opStr ? ` ${opStr}` : ''}`;
  return { opStr, full };
}

const SEG_GUARD: Record<number, string> = { 0x26: 'es', 0x2e: 'cs', 0x36: 'ss', 0x3e: 'ds', 0x64: 'fs', 0x65: 'gs' };

function formatImmIntel(v: bigint): string {
  if (v < 0n) return `-0x${(-v).toString(16)}`;
  return `0x${v.toString(16)}`;
}

function renderAtt(
  mnemonic: string,
  operands: Operand[],
  suffix: CustomResult['widthSuffix'],
  c: DecodeCtx,
  indirect = false,
): { opStr: string; full: string } {
  const m = applyAttMnemonic(mnemonic, suffix, c);
  const isBranchTarget = mnemonic.startsWith('j') || mnemonic === 'call' || mnemonic === 'callq';
  // Our operand arrays are Intel dest-first; AT&T needs source-first.
  const ordered = [...operands].reverse();
  const parts = ordered.map((op, idx) => {
    const sigil = indirect && idx === ordered.length - 1 ? '*' : '';
    if (op.kind === 'reg' || op.kind === 'fp-reg' || op.kind === 'sysreg') return `${sigil}%${op.reg}`;
    if (op.kind === 'imm') {
      // Branch/call targets print bare hex in objdump (no $).
      if (isBranchTarget) return formatBranchTarget(op.imm!);
      return formatImmAtt(op.imm!);
    }
    return sigil + renderMemAtt(op, c);
  });
  const opStr = parts.join(', ');
  const lock = c.pre.lock ? 'lock ' : '';
  const rep = c.pre.rep ? `${c.pre.rep === 0xf3 ? 'rep ' : 'repne '}` : '';
  const full = `${lock}${rep}${m}${opStr ? `\t${opStr}` : ''}`;
  return { opStr, full };
}

function formatBranchTarget(v: bigint): string {
  if (v < 0n) return `-0x${(-v).toString(16)}`;
  return `0x${v.toString(16)}`;
}

function applyAttMnemonic(mnemonic: string, suffix: CustomResult['widthSuffix'], c: DecodeCtx): string {
  // Mnemonics that already carry their size or have no suffix.
  const noSuffix = new Set([
    'nop', 'retq', 'lret', 'leave', 'cltq', 'cltd', 'cqto', 'cwde',
    'cdqe', 'syscall', 'sysenter', 'int3', 'int', 'ud2', 'hlt', 'cpuid',
    'rdtsc', 'rdmsr', 'wrmsr', 'lfence', 'mfence', 'sfence', 'emms',
    'jrcxz', 'jecxz', 'pushq', 'popq', 'enter', 'wbinvd', 'clc', 'stc',
    'cli', 'sti', 'cld', 'std', 'cmc', 'callq', 'jmpq', 'jmp',
  ]);
  // Conditional branches keep their bare mnemonic in objdump.
  if (WIDTH_BUILTIN.has(mnemonic)) return mnemonic;
  // setcc never takes a width suffix in objdump.
  if (mnemonic.startsWith('set')) return mnemonic;
  if (mnemonic === 'call') return 'callq';
  if (/^j[a-z]+/.test(mnemonic) && mnemonic !== 'jmp' && mnemonic !== 'jmpq') return mnemonic;
  if (noSuffix.has(mnemonic)) return mnemonic;
  if (mnemonic === 'ret') return 'retq';
  if (mnemonic.startsWith('cmov') || mnemonic.startsWith('set')) {
    return mnemonic + (suffix ?? 'l');
  }
  if (suffix === '' || suffix === undefined) {
    return mnemonic; // SSE/control mnemonics
  }
  return mnemonic + suffix;
}

function formatImmAtt(v: bigint): string {
  if (v < 0n) return `$-0x${(-v).toString(16)}`;
  return `$0x${v.toString(16)}`;
}

function renderMemAtt(op: Operand, c: DecodeCtx): string {
  const m = op.mem!;
  const seg = c.pre.seg >= 0 ? `%${SEG_GUARD[c.pre.seg]}:` : '';
  const disp = m.disp ?? 0n;
  const dispStr = disp < 0n ? `-0x${(-disp).toString(16)}` : `0x${disp.toString(16)}`;
  if (m.index) {
    // SIB form: disp(base, index, scale); objdump omits an explicit scale of 1.
    const base = m.base ? `%${m.base}` : '';
    const scale = m.scale ?? 1;
    const prefix = disp !== 0n || !m.base ? dispStr : '';
    const scaleTxt = scale !== 1 ? `, ${scale}` : '';
    return `${seg}${prefix}(${base}, %${m.index}${scaleTxt})`;
  }
  if (m.base) {
    return disp !== 0n ? `${seg}${dispStr}(%${m.base})` : `${seg}(%${m.base})`;
  }
  return `${seg}${dispStr}`;
}

/** Disassemble a contiguous run; stops at end of buffer or after a hard invalid. */
export function disassembleRange(bytes: Bytes, baseAddr: number, syntax: 'att' | 'intel' = 'att'): Instruction[] {
  const out: Instruction[] = [];
  let off = 0;
  while (off < bytes.length) {
    const slice = bytes.subarray(off);
    const inst = decodeInstruction(slice, baseAddr + off, { syntax });
    const len = inst.bytes.length || 1;
    out.push(inst);
    off += len;
  }
  return out;
}
