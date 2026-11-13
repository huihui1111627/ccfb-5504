// x86-64 scalar opcode tables (one-byte and two-byte 0F map).
// Vector entries for the 0F map are added by sse.ts.

import { OP1, OP2, type OpEntry, type OperandSpec } from './opref';
import type { X64Width } from './opref';

const G = (pos: number, w: X64Width | 'v' = 'v'): OperandSpec => ({ kind: 'r', width: w, pos });
const E = (pos: number, w: X64Width | 'v' | 'm' = 'v'): OperandSpec => ({ kind: 'rm', width: w, pos });
const I = (pos: number, width: 8 | 16 | 32 | 64, sign: 'u' | 's' = 's'): OperandSpec => ({ kind: 'imm', width, sign, pos });
const REL = (pos: number, width: 8 | 16 | 32): OperandSpec => ({ kind: 'imm-rel', width, pos });

// Opcode layout alternates width: +0 r/m8,r8; +1 r/m,r; +2 r8,r/m8; +3 r,r/m.
const binaryGroup = (base: string): OpEntry[] => [
  { m: base, operands: [E(0, 8), G(1, 8)], defW: 8, rexW64: false },
  { m: base, operands: [E(0), G(1)], defW: 32, rexW64: true },
  { m: base, operands: [G(0, 8), E(1, 8)], defW: 8, rexW64: false },
  { m: base, operands: [G(0), E(1)], defW: 32, rexW64: true },
];
const setBin = (off: number, base: string) => {
  binaryGroup(base).forEach((e, i) => (OP1[off + i] = e));
};
setBin(0x00, 'add'); setBin(0x08, 'or'); setBin(0x10, 'adc'); setBin(0x18, 'sbb');
setBin(0x20, 'and'); setBin(0x28, 'sub'); setBin(0x30, 'xor'); setBin(0x38, 'cmp');

OP1[0x04] = { m: 'add', operands: [{ kind: 'al', pos: 0 }, I(1, 8)], defW: 8, rexW64: false };
OP1[0x05] = { m: 'add', operands: [{ kind: 'eax', pos: 0 }, I(1, 32)], defW: 32 };
OP1[0x0c] = { m: 'or', operands: [{ kind: 'al', pos: 0 }, I(1, 8)], defW: 8, rexW64: false };
OP1[0x0d] = { m: 'or', operands: [{ kind: 'eax', pos: 0 }, I(1, 32)], defW: 32 };
OP1[0x14] = { m: 'adc', operands: [{ kind: 'al', pos: 0 }, I(1, 8)], defW: 8, rexW64: false };
OP1[0x15] = { m: 'adc', operands: [{ kind: 'eax', pos: 0 }, I(1, 32)], defW: 32 };
OP1[0x1c] = { m: 'sbb', operands: [{ kind: 'al', pos: 0 }, I(1, 8)], defW: 8, rexW64: false };
OP1[0x1d] = { m: 'sbb', operands: [{ kind: 'eax', pos: 0 }, I(1, 32)], defW: 32 };
OP1[0x24] = { m: 'and', operands: [{ kind: 'al', pos: 0 }, I(1, 8)], defW: 8, rexW64: false };
OP1[0x25] = { m: 'and', operands: [{ kind: 'eax', pos: 0 }, I(1, 32)], defW: 32 };
OP1[0x2c] = { m: 'sub', operands: [{ kind: 'al', pos: 0 }, I(1, 8)], defW: 8, rexW64: false };
OP1[0x2d] = { m: 'sub', operands: [{ kind: 'eax', pos: 0 }, I(1, 32)], defW: 32 };
OP1[0x34] = { m: 'xor', operands: [{ kind: 'al', pos: 0 }, I(1, 8)], defW: 8, rexW64: false };
OP1[0x35] = { m: 'xor', operands: [{ kind: 'eax', pos: 0 }, I(1, 32)], defW: 32 };
OP1[0x3c] = { m: 'cmp', operands: [{ kind: 'al', pos: 0 }, I(1, 8)], defW: 8, rexW64: false };
OP1[0x3d] = { m: 'cmp', operands: [{ kind: 'eax', pos: 0 }, I(1, 32)], defW: 32 };

for (let i = 0; i < 8; i++) {
  OP1[0x50 + i] = { m: 'push', operands: [], defW: 64, custom: 'push-pop-r' };
  OP1[0x58 + i] = { m: 'pop', operands: [], defW: 64, custom: 'push-pop-r' };
}
OP1[0x63] = { m: 'movslq', operands: [G(0, 64), E(1, 32)], defW: 32, rexW64: false };
OP1[0x68] = { m: 'push', operands: [I(0, 32)], defW: 32, custom: 'push-imm' };
OP1[0x69] = { m: 'imul', operands: [G(0), E(1), I(2, 32)], defW: 32 };
OP1[0x6a] = { m: 'push', operands: [I(0, 8)], defW: 8, custom: 'push-imm' };
OP1[0x6b] = { m: 'imul', operands: [G(0), E(1), I(2, 8)], defW: 32 };

const JCC = ['jo', 'jno', 'jb', 'jae', 'je', 'jne', 'jbe', 'ja', 'js', 'jns', 'jp', 'jnp', 'jl', 'jge', 'jle', 'jg'];
JCC.forEach((m, i) => {
  OP1[0x70 + i] = { m, operands: [REL(0, 8)], defW: 32, flow: 'jcc' };
});

OP1[0x80] = { m: 'group1', operands: [E(0, 8), I(1, 8)], defW: 8, arith: true, custom: 'group1-8' };
OP1[0x81] = { m: 'group1', operands: [E(0), I(1, 32)], defW: 32, arith: true, custom: 'group1-32' };
OP1[0x83] = { m: 'group1', operands: [E(0), I(1, 8)], defW: 32, arith: true, custom: 'group1-8' };
OP1[0x84] = { m: 'test', operands: [E(0, 8), G(1, 8)], defW: 8, rexW64: false };
OP1[0x85] = { m: 'test', operands: [E(0), G(1)], defW: 32 };
OP1[0x86] = { m: 'xchg', operands: [E(0, 8), G(1, 8)], defW: 8, rexW64: false };
OP1[0x87] = { m: 'xchg', operands: [E(0), G(1)], defW: 32 };
OP1[0x88] = { m: 'mov', operands: [E(0, 8), G(1, 8)], defW: 8, rexW64: false };
OP1[0x89] = { m: 'mov', operands: [E(0), G(1)], defW: 32, rexW64: true };
OP1[0x8a] = { m: 'mov', operands: [G(0, 8), E(1, 8)], defW: 8, rexW64: false };
OP1[0x8b] = { m: 'mov', operands: [G(0), E(1)], defW: 32, rexW64: true };
// LEA: target register width follows REX.W (64) or defaults to 32; the
// effective-address operand is always 64-bit regardless.
OP1[0x8d] = { m: 'lea', operands: [G(0, 'v'), E(1, 'm')], defW: 32, rexW64: true };
OP1[0x8f] = { m: 'pop', operands: [E(0, 64)], defW: 64, custom: 'group-pop' };
for (let i = 0; i < 8; i++) {
  OP1[0x90 + i] = { m: 'xchg', operands: [], defW: 64, custom: 'xchg-nop' };
}
OP1[0x98] = { m: 'cwde', operands: [], defW: 32, custom: 'cwde' };
OP1[0x99] = { m: 'cdq', operands: [], defW: 32, custom: 'cdq' };

const strOps: [number, string][] = [
  [0xa4, 'movsb'], [0xa5, 'movs'], [0xa6, 'cmpsb'], [0xa7, 'cmps'],
  [0xaa, 'stosb'], [0xab, 'stos'], [0xac, 'lodsb'], [0xad, 'lods'],
  [0xae, 'scasb'], [0xaf, 'scas'],
];
for (const [op, m] of strOps) OP1[op] = { m, operands: [], defW: 32, custom: 'string-op' };
OP1[0xa8] = { m: 'test', operands: [{ kind: 'al', pos: 0 }, I(1, 8)], defW: 8, rexW64: false };
OP1[0xa9] = { m: 'test', operands: [{ kind: 'eax', pos: 0 }, I(1, 32)], defW: 32 };
for (let i = 0; i < 8; i++) {
  OP1[0xb0 + i] = { m: 'mov', operands: [], defW: 8, rexW64: false, custom: 'mov-imm-r' };
  OP1[0xb8 + i] = { m: 'mov', operands: [], defW: 32, custom: 'mov-imm-r' };
}
OP1[0xc0] = { m: 'shift', operands: [E(0, 8), I(1, 8)], defW: 8, arith: true, custom: 'shift-imm' };
OP1[0xc1] = { m: 'shift', operands: [E(0), I(1, 8)], defW: 32, arith: true, custom: 'shift-imm' };
OP1[0xc2] = { m: 'ret', operands: [I(0, 16, 'u')], defW: 16, flow: 'ret', custom: 'ret-imm' };
OP1[0xc3] = { m: 'ret', operands: [], defW: 32, flow: 'ret' };
OP1[0xc6] = { m: 'mov', operands: [E(0, 8), I(1, 8)], defW: 8, rexW64: false };
OP1[0xc7] = { m: 'mov', operands: [E(0), I(1, 32)], defW: 32 };
OP1[0xc8] = { m: 'enter', operands: [I(0, 16, 'u'), I(1, 8, 'u')], defW: 16, custom: 'enter' };
OP1[0xc9] = { m: 'leave', operands: [], defW: 32 };
OP1[0xca] = { m: 'lret', operands: [I(0, 16, 'u')], defW: 16, flow: 'ret', custom: 'ret-imm' };
OP1[0xcb] = { m: 'lret', operands: [], defW: 32, flow: 'ret' };
OP1[0xcc] = { m: 'int3', operands: [], defW: 32, custom: 'int3' };
OP1[0xcd] = { m: 'int', operands: [I(0, 8, 'u')], defW: 8 };
OP1[0xce] = { m: 'into', operands: [], defW: 32 };
OP1[0xcf] = { m: 'iretq', operands: [], defW: 32, flow: 'ret' };
OP1[0xd0] = { m: 'shift', operands: [E(0, 8), { kind: '1', pos: 1 }], defW: 8, arith: true, custom: 'shift-cl' };
OP1[0xd1] = { m: 'shift', operands: [E(0), { kind: '1', pos: 1 }], defW: 32, arith: true, custom: 'shift-cl' };
OP1[0xd2] = { m: 'shift', operands: [E(0, 8), { kind: 'cl', pos: 1 }], defW: 8, arith: true, custom: 'shift-cl' };
OP1[0xd3] = { m: 'shift', operands: [E(0), { kind: 'cl', pos: 1 }], defW: 32, arith: true, custom: 'shift-cl' };
for (let op = 0xd9; op <= 0xdf; op++) OP1[op] = { m: 'x87', operands: [], defW: 32, custom: 'x87' };
OP1[0xe0] = { m: 'loopne', operands: [REL(0, 8)], defW: 32, flow: 'jcc' };
OP1[0xe1] = { m: 'loope', operands: [REL(0, 8)], defW: 32, flow: 'jcc' };
OP1[0xe2] = { m: 'loop', operands: [REL(0, 8)], defW: 32, flow: 'jcc' };
OP1[0xe3] = { m: 'jrcxz', operands: [REL(0, 8)], defW: 32, flow: 'jcc', custom: 'jrcxz' };
OP1[0xe8] = { m: 'call', operands: [REL(0, 32)], defW: 32, flow: 'call' };
OP1[0xe9] = { m: 'jmp', operands: [REL(0, 32)], defW: 32, flow: 'jmp' };
OP1[0xeb] = { m: 'jmp', operands: [REL(0, 8)], defW: 32, flow: 'jmp' };
OP1[0xea] = { m: 'ljmp', operands: [{ kind: 'imm-ptr', pos: 0 }], defW: 32, custom: 'far-ptr' };
OP1[0xf4] = { m: 'hlt', operands: [], defW: 32 };
OP1[0xf5] = { m: 'cmc', operands: [], defW: 32 };
OP1[0xf6] = { m: 'group3', operands: [E(0, 8)], defW: 8, custom: 'group3' };
OP1[0xf7] = { m: 'group3', operands: [E(0)], defW: 32, custom: 'group3' };
const flagOps: [number, string][] = [
  [0xf8, 'clc'], [0xf9, 'stc'], [0xfa, 'cli'], [0xfb, 'sti'], [0xfc, 'cld'], [0xfd, 'std'],
];
for (const [op, m] of flagOps) OP1[op] = { m, operands: [], defW: 32 };
OP1[0xfe] = { m: 'group4', operands: [E(0, 8)], defW: 8, arith: true, custom: 'group4' };
OP1[0xff] = { m: 'group5', operands: [E(0)], defW: 32, arith: true, custom: 'group5' };

// ---- 0F map ----
JCC.forEach((m, i) => {
  OP2[0x80 + i] = { m, operands: [REL(0, 32)], defW: 32, flow: 'jcc' };
});
const SETCC = ['seto', 'setno', 'setb', 'setae', 'sete', 'setne', 'setbe', 'seta',
  'sets', 'setns', 'setp', 'setnp', 'setl', 'setge', 'setle', 'setg'];
SETCC.forEach((m, i) => {
  OP2[0x90 + i] = { m, operands: [E(0, 8)], defW: 8, rexW64: false };
});
OP2[0xa0] = { m: 'push', operands: [], defW: 32, custom: 'push-seg' };
OP2[0xa1] = { m: 'pop', operands: [], defW: 32, custom: 'pop-seg' };
OP2[0xa8] = { m: 'push', operands: [], defW: 32, custom: 'push-seg-gs' };
OP2[0xa9] = { m: 'pop', operands: [], defW: 32, custom: 'pop-seg-gs' };
OP2[0xaf] = { m: 'imul', operands: [G(0), E(1)], defW: 32 };
OP2[0xb0] = { m: 'cmpxchg', operands: [E(0, 8), G(1, 8)], defW: 8, rexW64: false };
OP2[0xb1] = { m: 'cmpxchg', operands: [E(0), G(1)], defW: 32 };
OP2[0xb2] = { m: 'mov', operands: [], defW: 64, custom: 'mov-sys' };
OP2[0xb3] = { m: 'mov', operands: [], defW: 64, custom: 'mov-sys-dr' };
OP2[0xb6] = { m: 'movzbl', operands: [G(0, 64), E(1, 8)], defW: 32, rexW64: false, custom: 'movzx' };
OP2[0xb7] = { m: 'movzwl', operands: [G(0, 64), E(1, 16)], defW: 32, rexW64: false, custom: 'movzx' };
const CMOV = ['cmovo', 'cmovno', 'cmovb', 'cmovae', 'cmove', 'cmovne', 'cmovbe', 'cmova',
  'cmovs', 'cmovns', 'cmovp', 'cmovnp', 'cmovl', 'cmovge', 'cmovle', 'cmovg'];
CMOV.forEach((m, i) => {
  OP2[0x40 + i] = { m, operands: [G(0), E(1)], defW: 32 };
});
OP2[0xba] = { m: 'group8', operands: [E(0), I(1, 8)], defW: 32, arith: true, custom: 'group8' };
['bt', 'bts', 'btr', 'btc'].forEach((m, i) => {
  OP2[0xbb + i] = { m, operands: [E(0), G(1)], defW: 32, rexW64: true };
});
// 0F A3 = BT r/m, r (register form, no imm); 0F AB = BTS r/m,r etc.
OP2[0xa3] = { m: 'bt', operands: [E(0), G(1)], defW: 32, rexW64: true };
OP2[0xbc] = { m: 'bsf', operands: [G(0), E(1)], defW: 32 };
OP2[0xbd] = { m: 'bsr', operands: [G(0), E(1)], defW: 32 };
OP2[0xbe] = { m: 'movsbl', operands: [G(0, 64), E(1, 8)], defW: 32, rexW64: false, custom: 'movsx' };
OP2[0xbf] = { m: 'movswl', operands: [G(0, 64), E(1, 16)], defW: 32, rexW64: false, custom: 'movsx' };
OP2[0xc0] = { m: 'xadd', operands: [E(0, 8), G(1, 8)], defW: 8, rexW64: false };
OP2[0xc1] = { m: 'xadd', operands: [E(0), G(1)], defW: 32 };
for (let i = 0; i < 8; i++) {
  OP2[0xc8 + i] = { m: 'bswap', operands: [{ kind: 'r', width: 64, pos: 0 }], defW: 64, custom: 'bswap' };
}
OP2[0x05] = { m: 'syscall', operands: [], defW: 32, flow: 'sys' };
OP2[0x07] = { m: 'sysret', operands: [], defW: 32, flow: 'ret' };
OP2[0x0b] = { m: 'ud2', operands: [], defW: 32, custom: 'ud2' };
OP2[0x09] = { m: 'wbinvd', operands: [], defW: 32 };
OP2[0x1f] = { m: 'nop', operands: [E(0, 'm')], defW: 32, custom: 'nop-modrm' };
OP2[0x30] = { m: 'wrmsr', operands: [], defW: 32 };
OP2[0x31] = { m: 'rdtsc', operands: [], defW: 32 };
OP2[0x32] = { m: 'rdmsr', operands: [], defW: 32 };
OP2[0x33] = { m: 'rdpmc', operands: [], defW: 32 };
OP2[0x34] = { m: 'sysenter', operands: [], defW: 32, flow: 'sys' };
OP2[0x35] = { m: 'sysexit', operands: [], defW: 32, flow: 'ret' };
OP2[0xa2] = { m: 'cpuid', operands: [], defW: 32 };
OP2[0xae] = { m: 'group15', operands: [E(0, 'm')], defW: 32, custom: 'group15' };
OP2[0x77] = { m: 'emms', operands: [], defW: 32, custom: 'emms' };

// F3 0F B8 = popcnt, F3 0F BC = tzcnt, F3 0F BD = lzcnt — decoder rewrites mnemonic.
export const F3_PREFIX_OVERRIDE: Record<number, string> = {
  0xb8: 'popcnt', 0xbc: 'tzcnt', 0xbd: 'lzcnt',
};
