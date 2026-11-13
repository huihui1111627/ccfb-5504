// Minimal ELF64 stripper: drops .symtab/.strtab and debug sections while
// keeping dynsym/relocations, then rebuilds the section header table and a
// fresh .shstrtab. Pure TypeScript, no GNU binutils dependency.
//
// Usage: node --import tsx scripts/strip-elf.ts in.o out.o

import { readFileSync, writeFileSync } from 'node:fs';

const SHT_NOBITS = 8;

interface Sec {
  name: string;
  type: number;
  flags: bigint;
  addr: bigint;
  offset: bigint;
  size: bigint;
  link: number;
  info: number;
  addralign: bigint;
  data: Uint8Array;
}

function stripElf(input: Uint8Array): Uint8Array {
  const le = input[5] === 1;
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const u64 = (o: number) => dv.getBigUint64(o, le);

  const shoff = Number(u64(40));
  const shentsize = u16(58);
  const shnum = u16(60);
  const shstrndx = u16(62);

  const readC = (buf: Uint8Array, off: number) => {
    let e = off;
    while (e < buf.length && buf[e] !== 0) e++;
    return new TextDecoder().decode(buf.subarray(off, e));
  };

  const sections: Sec[] = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    const nameOff = u32(o);
    const type = u32(o + 4);
    const flags = u64(o + 8);
    const addr = u64(o + 16);
    const offset = u64(o + 24);
    const size = u64(o + 32);
    const link = u32(o + 40);
    const info = u32(o + 44);
    const addralign = u64(o + 48);
    const data = type === SHT_NOBITS ? new Uint8Array(0) : input.subarray(Number(offset), Number(offset) + Number(size));
    sections.push({ name: '', type, flags, addr, offset, size, link, info, addralign, data });
  }
  const shstr = sections[shstrndx];
  sections.forEach((s, idx) => {
    const o = shoff + idx * shentsize;
    s.name = readC(shstr.data, u32(o));
  });

  const drop = new Set(['.symtab', '.strtab', '.debug_info', '.debug_abbrev', '.debug_line',
    '.debug_str', '.debug_aranges', '.debug_ranges', '.debug_loc', '.note.GNU-stack']);
  const kept = sections.filter((s) => !drop.has(s.name));

  // Build the new shstrtab.
  const nameBytes: number[] = [0];
  const nameOffset = new Map<string, number>();
  for (const s of kept) {
    if (!nameOffset.has(s.name)) {
      nameOffset.set(s.name, nameBytes.length);
      nameBytes.push(...new TextEncoder().encode(s.name), 0);
    }
  }
  const shstrName = '.shstrtab';
  nameOffset.set(shstrName, nameBytes.length);
  nameBytes.push(...new TextEncoder().encode(shstrName), 0);
  const shstrtab = new Uint8Array(nameBytes);

  // Layout: ELF header (64) + program headers, then kept section bodies, then
  // the new shstrtab, then the section header table (null + kept + shstrtab).
  const phoff = Number(u64(32));
  const phnum = u16(56);
  const phentsize = u16(54);
  let cursor = Math.max(64, phnum ? phoff + phnum * phentsize : 0);

  const align = (v: number, a: bigint) => {
    const aN = Number(a);
    if (aN <= 1) return v;
    return Math.ceil(v / aN) * aN;
  };

  const layout: Array<{ sec: Sec; offset: number }> = [];
  for (const s of kept) {
    if (s.type === SHT_NOBITS || s.data.length === 0) continue;
    cursor = align(cursor, s.addralign);
    layout.push({ sec: s, offset: cursor });
    cursor += s.data.length;
  }
  cursor = align(cursor, 1n);
  const shstrtabOff = cursor;
  cursor += shstrtab.length;
  cursor = align(cursor, 8n);
  const shOffOut = cursor;
  const outShnum = kept.length + 2; // null + kept + shstrtab
  const totalLen = shOffOut + outShnum * 64;

  const out = new Uint8Array(totalLen);
  out.set(input.subarray(0, 64), 0);
  if (phnum) out.set(input.subarray(phoff, phoff + phnum * phentsize), phoff);
  const offOf = new Map<Sec, number>();
  for (const { sec, offset } of layout) {
    out.set(sec.data, offset);
    offOf.set(sec, offset);
  }
  out.set(shstrtab, shstrtabOff);

  const wdv = new DataView(out.buffer);
  wdv.setUint16(60, outShnum, le);
  wdv.setBigUint64(40, BigInt(shOffOut), le);
  const newShstrIndex = kept.length + 1;
  wdv.setUint16(62, newShstrIndex, le);

  // Map old section indices to new indices (for sh_link).
  const oldIndex = new Map<Sec, number>();
  sections.forEach((s, i) => oldIndex.set(s, i + 1));
  const newIndex = new Map<Sec, number>();
  kept.forEach((s, i) => newIndex.set(s, i + 1));

  const writeShdr = (idx: number, name: string, type: number, flags: bigint, addr: bigint,
    offset: bigint, size: bigint, link: number, info: number, addralign: bigint) => {
    const o = shOffOut + idx * 64;
    wdv.setUint32(o, nameOffset.get(name) ?? 0, le);
    wdv.setUint32(o + 4, type, le);
    wdv.setBigUint64(o + 8, flags, le);
    wdv.setBigUint64(o + 16, addr, le);
    wdv.setBigUint64(o + 24, offset, le);
    wdv.setBigUint64(o + 32, size, le);
    wdv.setUint32(o + 40, link, le);
    wdv.setUint32(o + 44, info, le);
    wdv.setBigUint64(o + 48, addralign || 1n, le);
    wdv.setBigUint64(o + 56, 0n, le);
  };
  writeShdr(0, '', 0, 0n, 0n, 0n, 0n, 0, 0, 0n);
  kept.forEach((s, i) => {
    // Relocation sections link to a now-removed symtab; clear dangling links.
    const linkedSec = s.link ? sections[s.link - 1] : undefined;
    const link = linkedSec && newIndex.has(linkedSec) ? newIndex.get(linkedSec)! : 0;
    const bodyOff = s.type === SHT_NOBITS ? 0 : (offOf.get(s) ?? 0);
    writeShdr(i + 1, s.name, s.type, s.flags, s.addr, BigInt(bodyOff), s.size, link, s.info, s.addralign);
  });
  writeShdr(newShstrIndex, shstrName, 3, 0n, 0n, BigInt(shstrtabOff), BigInt(shstrtab.length), 0, 0, 1n);

  return out;
}

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error('usage: strip-elf.ts <input> <output>');
  process.exit(1);
}
const output = stripElf(new Uint8Array(readFileSync(inPath)));
writeFileSync(outPath, output);
console.log(`stripped ${inPath} -> ${outPath}`);
