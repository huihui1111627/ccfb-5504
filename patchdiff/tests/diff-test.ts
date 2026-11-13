// End-to-end diff test across stripped/unstripped and both architectures.
// Stripped binaries have no symbol names, so correctness is checked against the
// unstripped build's address->name mapping rather than literal function names.
import { readFileSync } from 'node:fs';
import { analyzeBinary } from '../src/core/analysis';
import { diffBinaries } from '../src/core/differ';
import type { AnalyzedBinary } from '../src/core/types';

function load(path: string, id: string): AnalyzedBinary {
  return analyzeBinary(new Uint8Array(readFileSync(path)), id, path.split('/').pop()!);
}

const arch = process.argv[2] ?? 'x86_64';
const opt = process.argv[3] ?? 'O0';
const stripped = process.argv[4] === 'stripped';
const tag = stripped ? 'stripped' : 'unstripped';
const oldP = `samples/bin/fw.clang.${arch}.${opt}.rel.${tag}.o`;
const newP = `samples/bin/fw_patched.clang.${arch}.${opt}.rel.${tag}.o`;

const oldBin = load(oldP, 'old');
const newBin = load(newP, 'new');
console.log(`arch=${arch} opt=${opt} ${tag}`);

const result = diffBinaries(oldBin, newBin);
const assert = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };
assert(result.stats.total > 0, 'produced matches');

const changed = result.diffs.filter((d) => d.similarity < 1);

if (stripped) {
  // Map recovered sub_* addresses back to true names via the unstripped build.
  const oldRef = load(oldP.replace('stripped', 'unstripped'), 'or');
  const newRef = load(newP.replace('stripped', 'unstripped'), 'nr');
  const oldName = new Map(oldRef.functions.map((f) => [f.addr, f.name]));
  const newName = new Map(newRef.functions.map((f) => [f.addr, f.name]));
  let correct = 0;
  for (const m of result.matches.filter((m) => m.oldAddr !== undefined && m.newAddr !== undefined)) {
    if (oldName.get(m.oldAddr!) === newName.get(m.newAddr!)) correct++;
  }
  const paired = result.matches.filter((m) => m.oldAddr !== undefined && m.newAddr !== undefined).length;
  console.log(`stripped matching: ${correct}/${paired} correctly paired`);
  assert(correct === paired, 'all stripped function pairs must match the symbol ground truth');
  const changedTruth = new Set(changed.map((d) => oldName.get(d.match.oldAddr!)));
  for (const expected of ['fw_validate', 'fw_rollback_key', 'fw_dispatch']) {
    assert(changedTruth.has(expected), `expected ${expected} to show changes`);
  }
} else {
  const changedNames = new Set(changed.map((d) => d.match.oldName ?? ''));
  for (const expected of ['fw_validate', 'fw_rollback_key', 'fw_dispatch']) {
    assert(changedNames.has(expected), `expected ${expected} to show changes, got: ${[...changedNames].join(',')}`);
  }
  const unchanged = result.diffs.find((d) => (d.match.oldName ?? '') === 'fw_check_flag');
  assert(!!unchanged && unchanged.similarity === 1, 'fw_check_flag should be unchanged');
}

console.log(`modified functions: ${changed.length}, stats=`, result.stats);
console.log('ALL DIFF ASSERTIONS PASSED');
