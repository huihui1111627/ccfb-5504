// Opcode table storage shared by tables.ts (scalar entries) and sse.ts (vector entries).

export type OperandSpec =
  | { kind: 'r'; width: X64Width | 'v'; pos: number }
  | { kind: 'rm'; width: X64Width | 'v' | 'm'; pos: number }
  | { kind: 'imm'; width: 8 | 16 | 32 | 64; sign: 'u' | 's'; pos: number }
  | { kind: 'imm-rel'; width: 8 | 16 | 32; pos: number }
  | { kind: 'imm-ptr'; pos: number }
  | { kind: 'al' | 'cl' | 'ax' | 'eax' | 'rax' | 'dx' | '1'; pos: number }
  | { kind: 'moffs'; width: 32 | 64; pos: number }
  | { kind: 'xmm-r'; pos: number }
  | { kind: 'xmm-rm'; pos: number }
  | { kind: 'ymm-r'; pos: number }
  | { kind: 'ymm-rm'; pos: number };

export type X64Width = 8 | 16 | 32 | 64 | 128 | 256;

export type FlowHint =
  | 'call'
  | 'jmp'
  | 'jcc'
  | 'ret'
  | 'sys'
  | 'jmp-ind'
  | 'call-ind'
  | 'none';

export interface OpEntry {
  m: string;
  operands: OperandSpec[];
  defW: X64Width;
  rexW64?: boolean;
  opsize16?: boolean;
  flow?: FlowHint;
  arith?: boolean;
  custom?: string;
  vector?: boolean;
  ext?: '0f' | '0f38' | '0f3a';
}

export const OP1: (OpEntry | undefined)[] = new Array(256).fill(undefined);
export const OP2: (OpEntry | undefined)[] = new Array(256).fill(undefined);
export const OP38: (OpEntry | undefined)[] = new Array(256).fill(undefined);
export const OP3A: (OpEntry | undefined)[] = new Array(256).fill(undefined);
