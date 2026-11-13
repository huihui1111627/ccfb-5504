// Disassembly conformance harness: compare our disassembler against the
// system objdump (LLVM on macOS, GNU on Linux) instruction by instruction.
//
// Metrics:
//   byte-length agreement (we must stay in sync with the reference stream)
//   text agreement after normalizing addresses/relocation annotations
//
// Usage: node --import tsx tests/conformance.ts <elf-or-dir>...

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, extname } from 'node:path';
import { analyzeBinary } from '../src/core/analysis';
import { disassembleRange } from '../src/core/x64/decoder';
import { disassembleA64Range } from '../src/core/aarch64/decoder';
import { ELF_CONST } from '../src/core/elf';
import type { Instruction } from '../src/core/types';

interface RefInst {
  addr: number;
  bytes: number[];
  text: string;
}

function runObjdump(file: string, intel: boolean): RefInst[] {
  const args = ['-d'];
  if (intel) args.push('-M', 'intel');
  const raw = execFileSync('objdump', [...args, file], { maxBuffer: 64 * 1024 * 1024 }).toString();
  const out: RefInst[] = [];
  for (const line of raw.split('\n')) {
    // Layout: "   addr: bytes..." with the mnemonic separated by a tab or >=2 spaces.
    const m = line.match(/^\s*([0-9a-f]+):\s+([0-9a-f ]+?)(?:\t|\s{2,})(\S.*?)\s*$/);
    if (!m) continue;
    const addr = parseInt(m[1], 16);
    const bytes = m[2].trim().split(/\s+/).map((b) => parseInt(b, 16));
    let text = m[3];
    // Strip only objdump's annotations, keeping real operands intact:
    //   x86 "  # imm = 0x.." / "  # 0x.. <sym>"  |  A64 "  // =12544"  |  "  <sym+0x..>"
    text = text
      .replace(/\s+#\s+imm\s*=.*$/i, '')
      .replace(/\s+#\s+0x[0-9a-f]+ <.*?>$/, '')
      .replace(/\s+\/\/\s+=?.*$/, '')
      .replace(/\s+<[^>]+>$/, '')
      .trimEnd();
    out.push({ addr, bytes, text });
  }
  return out;
}

/** Normalize instruction text for comparison. */
function norm(text: string, arch: string): string {
  let t = text.trim().replace(/\s+/g, ' ');
  // Branch/call target hex values differ in formatting only.
  t = t.replace(/0x([0-9a-f]+)/g, (h) => '0x' + h.slice(2).toLowerCase());
  // LLVM objdump renders negative disp as -0x.. same as us; unify spacing.
  t = t.replace(/\s*,\s*/g, ', ');
  void arch;
  return t;
}

interface Report {
  file: string;
  total: number;
  lengthMismatch: number;
  textMismatch: number;
  examples: Array<{ addr: number; ours: string; ref: string; bytes: string }>;
}

function compare(file: string, intel = false): Report {
  const bin = analyzeBinary(new Uint8Array(readFileSync(file)), 'x', file);
  const ref = runObjdump(file, intel);
  // Disassemble every executable section whole, so inter-function padding
  // (multi-byte NOPs) is included in the comparison.
  const ours = new Map<number, Instruction>();
  for (const s of bin.sections) {
    if (!(s.flags & ELF_CONST.SHF_EXECINSTR) || s.type === 8 || s.size === 0) continue;
    const list = bin.arch === 'x86_64'
      ? disassembleRange(s.data, s.addr, intel ? 'intel' : 'att')
      : disassembleA64Range(s.data, s.addr);
    for (const i of list) ours.set(i.addr, i);
  }
  const aarch = bin.arch === 'aarch64';
  const rep: Report = {
    file,
    total: ref.length,
    lengthMismatch: 0,
    textMismatch: 0,
    examples: [],
  };
  for (const r of ref) {
    const o = ours.get(r.addr);
    if (!o) {
      rep.lengthMismatch++;
      if (rep.examples.length < 12) rep.examples.push({ addr: r.addr, ours: '<missing>', ref: r.text, bytes: r.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ') });
      continue;
    }
    if (o.bytes.length !== r.bytes.length && !aarch) {
      rep.lengthMismatch++;
      if (rep.examples.length < 12) rep.examples.push({ addr: r.addr, ours: `LEN ${o.bytes.length}: ${o.text}`, ref: `LEN ${r.bytes.length}: ${r.text}`, bytes: r.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ') });
      continue;
    }
    // AArch64 instructions are fixed-width 4 bytes; objdump prints the word as
    // 4 byte tokens, so compare against that constant rather than token count.
    if (aarch && o.bytes.length !== 4) {
      rep.lengthMismatch++;
      if (rep.examples.length < 12) rep.examples.push({ addr: r.addr, ours: `LEN ${o.bytes.length}: ${o.text}`, ref: `LEN 4: ${r.text}`, bytes: r.bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ') });
      continue;
    }
    const a = norm(o.text, bin.arch);
    const b = norm(r.text, bin.arch);
    if (a !== b) {
      rep.textMismatch++;
      if (rep.examples.length < 24) rep.examples.push({ addr: r.addr, ours: a, ref: b, bytes: r.bytes.map((bb) => bb.toString(16).padStart(2, '0')).join(' ') });
    }
  }
  return rep;
}

function walk(path: string): string[] {
  if (statSync(path).isDirectory()) {
    return readdirSync(path).flatMap((n) => walk(join(path, n)));
  }
  return extname(path) === '.o' || path.endsWith('.elf') ? [path] : [];
}

const targets = process.argv.slice(2).flatMap(walk);
if (targets.length === 0) {
  console.error('usage: conformance.ts <elf-file-or-dir>...');
  process.exit(1);
}
let grandTotal = 0;
let grandLen = 0;
let grandTxt = 0;
for (const t of targets) {
  try {
    const r = compare(t);
    grandTotal += r.total;
    grandLen += r.lengthMismatch;
    grandTxt += r.textMismatch;
    const agree = ((r.total - r.lengthMismatch - r.textMismatch) / Math.max(1, r.total) * 100).toFixed(2);
    console.log(`${r.file.split('/').pop()}: ${r.total} insts, len-bad=${r.lengthMismatch}, text-bad=${r.textMismatch}, agree=${agree}%`);
    for (const e of r.examples.slice(0, 8)) {
      console.log(`  0x${e.addr.toString(16)} [${e.bytes}]\n    ours: ${e.ours}\n    ref : ${e.ref}`);
    }
  } catch (e) {
    console.log(`${t}: ERROR ${(e as Error).message}`);
  }
}
const pct = ((grandTotal - grandLen - grandTxt) / Math.max(1, grandTotal) * 100).toFixed(3);
console.log(`\nTOTAL ${grandTotal} instructions | length errors ${grandLen} | text errors ${grandTxt} | conformance ${pct}%`);
