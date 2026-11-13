// SSE/SSE2/SSSE3/SSE4 opcode entries filling the 0F / 0F38 / 0F3A maps.

import { OP2, OP38, OP3A, type OpEntry } from './opref';

const XR = (pos: number): OpEntry['operands'][number] => ({ kind: 'xmm-r', pos });
const XM = (pos: number): OpEntry['operands'][number] => ({ kind: 'xmm-rm', pos });
const Iu = (pos: number): OpEntry['operands'][number] => ({ kind: 'imm', width: 8, sign: 'u', pos });

type Pat = 'rm' | 'mr' | 'r' | 'm' | 'rr';
type Flavor = 'ps' | 'pd' | 'ss' | 'sd' | 'int' | 'int128';

function sseEntry(map: 1 | 2 | 3, op: number, m: string, flavor: Flavor, pat: Pat, imm = false): void {
  // Stored in Intel dest-first order; AT&T renderer reverses.
  const operands: OpEntry['operands'] = [];
  if (pat === 'rm') operands.push(XR(0), XM(1));
  else if (pat === 'mr') operands.push(XM(0), XR(1));
  else if (pat === 'rr') operands.push(XR(0), XM(1));
  else if (pat === 'r') operands.push(XR(0));
  else operands.push(XM(0));
  if (imm) operands.push(Iu(operands.length));
  const e: OpEntry = { m, operands, defW: flavor === 'ps' || flavor === 'pd' ? 128 : 32, vector: true, custom: `sse:${flavor}` };
  if (map === 2) OP38[op] = e;
  else if (map === 3) OP3A[op] = e;
  else OP2[op] = e;
}

const twoByte: Array<[number, string, Flavor, Pat, boolean?]> = [
  [0x10, 'movups', 'ps', 'rm'], [0x11, 'movups', 'ps', 'mr'],
  [0x12, 'movhlps', 'ps', 'rm'], [0x13, 'movlps', 'ps', 'mr'],
  [0x14, 'unpcklps', 'ps', 'rm'], [0x15, 'unpckhps', 'ps', 'rm'],
  [0x16, 'movhps', 'ps', 'mr'], [0x17, 'movhps', 'ps', 'rm'],
  [0x28, 'movaps', 'ps', 'rm'], [0x29, 'movaps', 'ps', 'mr'],
  [0x2e, 'ucomiss', 'ss', 'rm'], [0x2f, 'comiss', 'ss', 'rm'],
  [0x51, 'sqrtps', 'ps', 'rm'], [0x52, 'rsqrtps', 'ps', 'rm'],
  [0x53, 'rcpps', 'ps', 'rm'], [0x54, 'andps', 'ps', 'rm'],
  [0x55, 'andnps', 'ps', 'rm'], [0x56, 'orps', 'ps', 'rm'], [0x57, 'xorps', 'ps', 'rm'],
  [0x58, 'addps', 'ps', 'rm'], [0x59, 'mulps', 'ps', 'rm'],
  [0x5a, 'cvtps2pd', 'pd', 'rm'], [0x5b, 'cvtdq2ps', 'ps', 'rm'],
  [0x5c, 'subps', 'ps', 'rm'], [0x5d, 'minps', 'ps', 'rm'],
  [0x5e, 'divps', 'ps', 'rm'], [0x5f, 'maxps', 'ps', 'rm'],
  [0x60, 'punpcklbw', 'int', 'rm'], [0x61, 'punpcklwd', 'int', 'rm'],
  [0x62, 'punpckldq', 'int', 'rm'], [0x63, 'packsswb', 'int', 'rm'],
  [0x64, 'pcmpgtb', 'int', 'rm'], [0x65, 'pcmpgtw', 'int', 'rm'],
  [0x66, 'pcmpgtd', 'int', 'rm'], [0x67, 'packuswb', 'int', 'rm'],
  [0x68, 'punpckhbw', 'int', 'rm'], [0x69, 'punpckhwd', 'int', 'rm'],
  [0x6a, 'punpckhdq', 'int', 'rm'], [0x6b, 'packssdw', 'int', 'rm'],
  [0x6e, 'movd', 'int', 'rm'], [0x6f, 'movq', 'int128', 'rm'],
  [0x70, 'pshufd', 'int', 'rm', true], [0x71, 'psllw', 'int', 'rm', true],
  [0x72, 'pslld', 'int', 'rm', true], [0x73, 'psllq', 'int', 'rm', true],
  [0x74, 'pcmpeqb', 'int', 'rm'], [0x75, 'pcmpeqw', 'int', 'rm'],
  [0x76, 'pcmpeqd', 'int', 'rm'],
  [0x7e, 'movd', 'int', 'mr'], [0x7f, 'movdqa', 'int128', 'rm'],
  [0xc2, 'cmpps', 'ps', 'rm', true], [0xc6, 'shufps', 'ps', 'rm', true],
  [0xd0, 'addsubps', 'ps', 'rm'], [0xd1, 'psrlw', 'int', 'rm'],
  [0xd2, 'psrld', 'int', 'rm'], [0xd3, 'psrlq', 'int', 'rm'],
  [0xd4, 'paddq', 'int', 'rm'], [0xd5, 'pmullw', 'int', 'rm'],
  [0xd6, 'movq', 'int', 'mr'], [0xd7, 'pmovmskb', 'int', 'rm'],
  [0xd8, 'psubusb', 'int', 'rm'], [0xd9, 'psubusw', 'int', 'rm'],
  [0xda, 'pminub', 'int', 'rm'], [0xdb, 'pand', 'int', 'rm'],
  [0xdc, 'paddusb', 'int', 'rm'], [0xdd, 'paddusw', 'int', 'rm'],
  [0xde, 'pmaxub', 'int', 'rm'], [0xdf, 'pandn', 'int', 'rm'],
  [0xe0, 'pavgb', 'int', 'rm'], [0xe1, 'psraw', 'int', 'rm'],
  [0xe2, 'psrad', 'int', 'rm'], [0xe3, 'psraq', 'int', 'rm'],
  [0xe4, 'pavgw', 'int', 'rm'], [0xe5, 'pmulhuw', 'int', 'rm'],
  [0xe6, 'cvtdq2pd', 'pd', 'rm'], [0xe7, 'movntdq', 'int128', 'mr'],
  [0xe8, 'psubsb', 'int', 'rm'], [0xe9, 'psubsw', 'int', 'rm'],
  [0xea, 'pminsw', 'int', 'rm'], [0xeb, 'por', 'int', 'rm'],
  [0xec, 'paddsb', 'int', 'rm'], [0xed, 'paddsw', 'int', 'rm'],
  [0xee, 'pmaxsw', 'int', 'rm'], [0xef, 'pxor', 'int', 'rm'],
  [0xf1, 'psllw', 'int', 'rm'], [0xf2, 'pslld', 'int', 'rm'], [0xf3, 'psllq', 'int', 'rm'],
  [0xf4, 'pmuludq', 'int', 'rm'], [0xf5, 'pmaddwd', 'int', 'rm'],
  [0xf6, 'psadbw', 'int', 'rm'], [0xf7, 'maskmovdqu', 'int', 'rm'],
  [0xf8, 'psubb', 'int', 'rm'], [0xf9, 'psubw', 'int', 'rm'],
  [0xfa, 'psubd', 'int', 'rm'], [0xfb, 'psubq', 'int', 'rm'],
  [0xfc, 'paddb', 'int', 'rm'], [0xfd, 'paddw', 'int', 'rm'],
  [0xfe, 'paddd', 'int', 'rm'], [0xff, 'paddq', 'int', 'rm'],
];
for (const [op, m, kind, pat, imm] of twoByte) sseEntry(1, op, m, kind, pat, imm);

const map38: Array<[number, string, Flavor, Pat, boolean?]> = [
  [0x00, 'pshufb', 'int', 'rm'], [0x01, 'phaddw', 'int', 'rm'],
  [0x02, 'phaddd', 'int', 'rm'], [0x03, 'phaddsw', 'int', 'rm'],
  [0x04, 'pmaddubsw', 'int', 'rm'], [0x05, 'phsubw', 'int', 'rm'],
  [0x06, 'phsubd', 'int', 'rm'], [0x07, 'phsubsw', 'int', 'rm'],
  [0x08, 'psignb', 'int', 'rm'], [0x09, 'psignw', 'int', 'rm'],
  [0x0a, 'psignd', 'int', 'rm'], [0x0b, 'pmulhrsw', 'int', 'rm'],
  [0x10, 'pblendvb', 'int', 'rm'], [0x14, 'blendvps', 'ps', 'rm'],
  [0x15, 'blendvpd', 'pd', 'rm'], [0x17, 'ptest', 'int', 'rm'],
  [0x1c, 'pabsb', 'int', 'rm'], [0x1d, 'pabsw', 'int', 'rm'],
  [0x1e, 'pabsd', 'int', 'rm'], [0x20, 'pmovsxbw', 'int', 'rm'],
  [0x21, 'pmovsxbd', 'int', 'rm'], [0x22, 'pmovsxbq', 'int', 'rm'],
  [0x23, 'pmovsxwd', 'int', 'rm'], [0x25, 'pmovsxwq', 'int', 'rm'],
  [0x29, 'packusdw', 'int', 'rm'], [0x2c, 'pmovusxbw', 'int', 'rm'],
  [0x30, 'pmovzxbw', 'int', 'rm'], [0x31, 'pmovzxbd', 'int', 'rm'],
  [0x33, 'pmovzxdq', 'int', 'rm'], [0x37, 'pcmpgtq', 'int', 'rm'],
  [0x3a, 'pcmpestrm', 'int', 'rm', true], [0x3b, 'pcmpestri', 'int', 'rm', true],
  [0x3c, 'pcmpistrm', 'int', 'rm', true], [0x3d, 'pcmpistri', 'int', 'rm', true],
  [0x40, 'pmulld', 'int', 'rm'], [0x41, 'phminposuw', 'int', 'rm'],
  [0xf2, 'andn', 'int', 'rr'], [0xf5, 'bzhi', 'int', 'rr'], [0xf7, 'bextr', 'int', 'rr'],
];
for (const [op, m, kind, pat, imm] of map38) sseEntry(2, op, m, kind, pat, imm);

const map3a: Array<[number, string, Flavor, Pat]> = [
  [0x08, 'roundps', 'ps', 'rm'], [0x09, 'roundpd', 'pd', 'rm'],
  [0x0a, 'roundss', 'ss', 'rm'], [0x0b, 'roundsd', 'sd', 'rm'],
  [0x0c, 'blendps', 'ps', 'rm'], [0x0d, 'blendpd', 'pd', 'rm'],
  [0x0e, 'pblendw', 'int', 'rm'], [0x14, 'pextrb', 'int', 'rm'],
  [0x15, 'pextrd', 'int', 'rm'], [0x16, 'pextrq', 'int', 'rm'],
  [0x17, 'ptest', 'int', 'rm'], [0x20, 'pinsrb', 'int', 'rm'],
  [0x21, 'insertps', 'ps', 'rm'], [0x22, 'pinsrd', 'int', 'rm'],
  [0x23, 'pinsrq', 'int', 'rm'], [0x40, 'dpps', 'ps', 'rm'],
  [0x41, 'dppd', 'pd', 'rm'], [0x42, 'mpsadbw', 'int', 'rm'],
  [0xdf, 'aeskeygenassist', 'int', 'rm'],
];
for (const [op, m, kind, pat] of map3a) sseEntry(3, op, m, kind, pat, true);

// Prefix-switched 0F entries: same opcode position, different mnemonic/suffix.
// key: (66|f3|f2) << 8 | opcode2
export const SSE_PREFIX_OVERRIDE: Record<number, { m: string; flavor: Flavor }> = {
  // 0F 10 movups; 66 -> movupd; F3 -> movss; F2 -> movsd
  0x6610: { m: 'movupd', flavor: 'pd' },
  0xf310: { m: 'movss', flavor: 'ss' },
  0xf210: { m: 'movsd', flavor: 'sd' },
  0x6611: { m: 'movupd', flavor: 'pd' },
  0xf311: { m: 'movss', flavor: 'ss' },
  0xf211: { m: 'movsd', flavor: 'sd' },
  0x6628: { m: 'movapd', flavor: 'pd' },
  0x6629: { m: 'movapd', flavor: 'pd' },
  0xf32e: { m: 'ucomisd', flavor: 'sd' },
  0xf32f: { m: 'comisd', flavor: 'sd' },
  0xf351: { m: 'sqrtss', flavor: 'ss' },
  0xf251: { m: 'sqrtsd', flavor: 'sd' },
  0x6651: { m: 'sqrtpd', flavor: 'pd' },
  0xf358: { m: 'addss', flavor: 'ss' },
  0xf258: { m: 'addsd', flavor: 'sd' },
  0x6658: { m: 'addpd', flavor: 'pd' },
  0xf359: { m: 'mulss', flavor: 'ss' },
  0xf259: { m: 'mulsd', flavor: 'sd' },
  0x6659: { m: 'mulpd', flavor: 'pd' },
  0xf35c: { m: 'subss', flavor: 'ss' },
  0xf25c: { m: 'subsd', flavor: 'sd' },
  0x665c: { m: 'subpd', flavor: 'pd' },
  0xf35e: { m: 'divss', flavor: 'ss' },
  0xf25e: { m: 'divsd', flavor: 'sd' },
  0x665e: { m: 'divpd', flavor: 'pd' },
  0xf35d: { m: 'minss', flavor: 'ss' },
  0xf25d: { m: 'minsd', flavor: 'sd' },
  0x665d: { m: 'minpd', flavor: 'pd' },
  0xf35f: { m: 'maxss', flavor: 'ss' },
  0xf25f: { m: 'maxsd', flavor: 'sd' },
  0x665f: { m: 'maxpd', flavor: 'pd' },
  0xf35a: { m: 'cvtss2sd', flavor: 'sd' },
  0xf25a: { m: 'cvtsd2ss', flavor: 'ss' },
  0x665a: { m: 'cvtps2pd', flavor: 'pd' },
  0xf36f: { m: 'movdqu', flavor: 'int128' },
  0x666f: { m: 'movdqa', flavor: 'int128' },
  0xf37f: { m: 'movdqu', flavor: 'int128' },
  0x667f: { m: 'movdqa', flavor: 'int128' },
  0x66ef: { m: 'pxor', flavor: 'int' }, // 66 0F EF = pxor (vs xorps)
  0xf36e: { m: 'movq', flavor: 'int' },
  0x666e: { m: 'movd', flavor: 'int' },
  0xf37e: { m: 'movq', flavor: 'int' },
  0xf2c2: { m: 'cmpsd', flavor: 'sd' },
  0x66c2: { m: 'cmppd', flavor: 'pd' },
  0x66c6: { m: 'shufpd', flavor: 'pd' },
  0x660f: { m: 'nop', flavor: 'int' }, // 66 0F 1F handled separately
};
