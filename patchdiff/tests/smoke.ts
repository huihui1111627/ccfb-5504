// Smoke test: compile C to ELF objects, analyze, and spot-check decoding.
// Run: node --experimental-transform-types tests/smoke.ts
import { analyzeBinary } from '../src/core/analysis';
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: node --experimental-transform-types tests/smoke.ts <elf-file>');
  process.exit(1);
}
const bytes = new Uint8Array(readFileSync(path));
const bin = analyzeBinary(bytes, 't', path);
console.log(`arch=${bin.arch} type=${bin.type} sections=${bin.sections.length} funcs=${bin.functions.length} strings=${bin.strings.length} relocs=${bin.relocations.length}`);
for (const f of bin.functions.slice(0, 3)) {
  console.log(`\n== ${f.name} @0x${f.addr.toString(16)} size=${f.size} blocks=${f.blocks.length} recovered=${f.recovered}`);
  for (const i of f.insts.slice(0, 12)) {
    const hex = Array.from(i.bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`  ${i.addr.toString(16).padStart(6)}: ${hex.padEnd(24)} ${i.text}${i.comment ? '  # ' + i.comment : ''}`);
  }
}
