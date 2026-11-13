// ELF64 parser (little/big endian). Produces sections, symbols, imports,
// strings and relocations. Only ELFCLASS64 is fully modeled because the
// target architectures (x86-64, AArch64) are 64-bit, but class/endian are
// validated explicitly so bad input fails loudly instead of misreading.

import type {
  Arch, Bytes,
  Relocation,
  Section,
  StringEntry,
  Symbol,
  SymbolBind,
  SymbolType,
} from './types';

const SHT = {
  NULL: 0,
  PROGBITS: 1,
  SYMTAB: 2,
  STRTAB: 3,
  RELA: 4,
  HASH: 5,
  DYNAMIC: 6,
  NOTE: 7,
  NOBITS: 8,
  REL: 9,
  DYNSYM: 11,
  INIT_ARRAY: 14,
  FINI_ARRAY: 15,
} as const;

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;

const STT_NAMES: SymbolType[] = [
  'notype',
  'object',
  'function',
  'section',
  'file',
  'common',
  'tls',
];

const STV = ['default', 'internal', 'hidden', 'protected'];

export interface ElfHeader {
  arch: Arch;
  is64bit: boolean;
  littleEndian: boolean;
  type: number;
  typeName: string;
  entry: number;
  phoff: number;
  shoff: number;
  phentsize: number;
  phnum: number;
  shentsize: number;
  shnum: number;
  shstrndx: number;
}

export class ElfParseError extends Error {}

/** Bounded view over the file with endian-aware readers. */
export class ByteReader {
  view: DataView;

  constructor(public bytes: Bytes) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(off: number): number {
    return this.view.getUint8(off);
  }
  u16(off: number, le = true): number {
    return this.view.getUint16(off, le);
  }
  u32(off: number, le = true): number {
    return this.view.getUint32(off, le);
  }
  u64(off: number, le = true): bigint {
    return this.view.getBigUint64(off, le);
  }
  i32(off: number, le = true): number {
    return this.view.getInt32(off, le);
  }
  i64(off: number, le = true): bigint {
    return this.view.getBigInt64(off, le);
  }
  slice(off: number, len: number): Uint8Array {
    return this.bytes.subarray(off, off + len);
  }
  /** Number (not bigint) u64 reader — firmware ELFs fit in 2^53. */
  u64n(off: number, le = true): number {
    return Number(this.view.getBigUint64(off, le));
  }
}

export interface ParsedElf {
  header: ElfHeader;
  sections: Section[];
  symbols: Symbol[];
  imports: Symbol[];
  exports: Symbol[];
  strings: StringEntry[];
  relocations: Relocation[];
  reader: ByteReader;
  buildId?: string;
}

const EM_X86_64 = 62;
const EM_AARCH64 = 183;

const ET_NAMES: Record<number, string> = {
  0: 'ET_NONE',
  1: 'ET_REL',
  2: 'ET_EXEC',
  3: 'ET_DYN',
  4: 'ET_CORE',
};

// Relocation type names per architecture (subset that compiler output emits).
const R_X86_64: Record<number, string> = {
  0: 'R_X86_64_NONE',
  1: 'R_X86_64_64',
  2: 'R_X86_64_PC32',
  3: 'R_X86_64_GOT32',
  4: 'R_X86_64_PLT32',
  5: 'R_X86_64_COPY',
  6: 'R_X86_64_GLOB_DAT',
  7: 'R_X86_64_JUMP_SLOT',
  8: 'R_X86_64_RELATIVE',
  9: 'R_X86_64_GOTPCREL',
  10: 'R_X86_64_32',
  11: 'R_X86_64_32S',
  24: 'R_X86_64_PC64',
  25: 'R_X86_64_GOTOFF64',
  26: 'R_X86_64_GOTPC32',
  37: 'R_X86_64_IRELATIVE',
};

const R_AARCH64: Record<number, string> = {
  0: 'R_AARCH64_NONE',
  257: 'R_AARCH64_ABS64',
  258: 'R_AARCH64_ABS32',
  261: 'R_AARCH64_ADR_PREL_PG_HI21',
  262: 'R_AARCH64_ADR_PREL_PG_HI21_NC',
  263: 'R_AARCH64_ADD_ABS_LO12_NC',
  274: 'R_AARCH64_CALL26',
  275: 'R_AARCH64_JUMP26',
  276: 'R_AARCH64_CONDBR19',
  282: 'R_AARCH64_ADR_GOT_PAGE',
  283: 'R_AARCH64_LD64_GOT_LO12_NC',
  286: 'R_AARCH64_LD_PREL_LO19',
  1024: 'R_AARCH64_COPY',
  1025: 'R_AARCH64_GLOB_DAT',
  1026: 'R_AARCH64_JUMP_SLOT',
  1027: 'R_AARCH64_RELATIVE',
  1028: 'R_AARCH64_TLSDESC',
  1032: 'R_AARCH64_IRELATIVE',
};

export function parseElf(bytes: Uint8Array): ParsedElf {
  if (bytes.length < 64) throw new ElfParseError('file too small to be an ELF');
  if (bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new ElfParseError('bad ELF magic');
  }
  const eiClass = bytes[4];
  const eiData = bytes[5];
  if (eiClass !== 2) throw new ElfParseError('only ELFCLASS64 supported');
  const le = eiData === 1;
  if (!le && eiData !== 2) throw new ElfParseError('invalid EI_DATA');
  const r = new ByteReader(bytes);

  const eType = r.u16(16, le);
  const machine = r.u16(18, le);
  let arch: Arch;
  if (machine === EM_X86_64) arch = 'x86_64';
  else if (machine === EM_AARCH64) arch = 'aarch64';
  else throw new ElfParseError(`unsupported e_machine ${machine}; only x86-64 and AArch64`);

  const header: ElfHeader = {
    arch,
    is64bit: true,
    littleEndian: le,
    type: eType,
    typeName: ET_NAMES[eType] ?? `ET_${eType}`,
    entry: r.u64n(24, le),
    phoff: r.u64n(32, le),
    shoff: r.u64n(40, le),
    phentsize: r.u16(54, le),
    phnum: r.u16(56, le),
    shentsize: r.u16(58, le),
    shnum: r.u16(60, le),
    shstrndx: r.u16(62, le),
  };

  const sections = parseSections(r, header);
  const { symbols, imports, exports } = parseSymbols(r, header, sections);
  const strings = parseStrings(sections);
  const relocations = parseRelocs(r, header, sections, symbols, arch);
  const buildId = parseBuildId(r, header, sections);

  return { header, sections, symbols, imports, exports, strings, relocations, reader: r, buildId };
}

function parseSections(r: ByteReader, h: ElfHeader): Section[] {
  const out: Section[] = [];
  for (let i = 0; i < h.shnum; i++) {
    const off = h.shoff + i * h.shentsize;
    const nameOff = r.u32(off, h.littleEndian);
    const type = r.u32(off + 4, h.littleEndian);
    const flags = r.u64n(off + 8, h.littleEndian);
    const addr = r.u64n(off + 16, h.littleEndian);
    const fileOff = r.u64n(off + 24, h.littleEndian);
    const size = r.u64n(off + 32, h.littleEndian);
    const link = r.u32(off + 40, h.littleEndian);
    const info = r.u32(off + 44, h.littleEndian);
    const addralign = r.u64n(off + 48, h.littleEndian);
    let data: Bytes = new Uint8Array(0);
    if (type !== SHT.NOBITS && size > 0) {
      data = r.slice(fileOff, Math.min(size, r.bytes.length - fileOff));
    }
    out.push({
      name: '', // resolved after shstrtab section is known
      type,
      flags,
      addr,
      offset: fileOff,
      size,
      link,
      info,
      addralign,
      data,
    });
  }
  // Resolve section names.
  const shstr = out[h.shstrndx];
  if (shstr) {
    for (const s of out) {
      s.name = readCStr(shstr.data, r.u32(h.shoff + out.indexOf(s) * h.shentsize, h.littleEndian));
    }
  }
  return out;
}

export function readCStr(buf: Uint8Array, off: number): string {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end++;
  return new TextDecoder('utf-8', { fatal: false }).decode(buf.subarray(off, end));
}

interface RawSym {
  name: string;
  value: number;
  size: number;
  info: number;
  other: number;
  shndx: number;
}

function parseSymbols(
  r: ByteReader,
  h: ElfHeader,
  sections: Section[],
): { symbols: Symbol[]; imports: Symbol[]; exports: Symbol[] } {
  const raws: RawSym[] = [];
  for (const s of sections) {
    if (s.type !== SHT.SYMTAB && s.type !== SHT.DYNSYM) continue;
    const strtab = sections[s.link];
    const count = Math.floor(s.size / 24);
    for (let i = 0; i < count; i++) {
      const base = s.offset + i * 24;
      const nameOff = r.u32(base, h.littleEndian);
      const info = r.u8(base + 4);
      const other = r.u8(base + 5);
      const shndx = r.u16(base + 6, h.littleEndian);
      const value = r.u64n(base + 8, h.littleEndian);
      const size = r.u64n(base + 16, h.littleEndian);
      const name = strtab ? readCStr(strtab.data, nameOff) : '';
      raws.push({ name, value, size, info, other, shndx });
    }
  }

  const sectionName = (idx: number): string => {
    if (idx === 0) return 'UND';
    if (idx === 0xfff1) return 'ABS';
    if (idx === 0xfff2) return 'COMMON';
    return sections[idx]?.name ?? `SHN_${idx}`;
  };

  const symbols: Symbol[] = [];
  const seen = new Set<string>();
  for (const rs of raws) {
    if (!rs.name && rs.shndx === 0) continue;
    const typeIdx = rs.info & 0xf;
    const bindIdx = rs.info >> 4;
    const type: SymbolType = STT_NAMES[typeIdx] ?? 'notype';
    const bind: SymbolBind = bindIdx === 1 ? 'global' : bindIdx === 2 ? 'weak' : 'local';
    const key = `${rs.name}@${rs.value}@${rs.shndx}`;
    if (seen.has(key)) continue; // dynsym duplicates symtab entries
    seen.add(key);
    const imported = rs.shndx === 0 && (type === 'function' || type === 'object' || type === 'notype');
    const sym: Symbol = {
      name: rs.name || sectionName(rs.shndx),
      value: rs.value,
      size: rs.size,
      type,
      bind,
      sectionIndex: rs.shndx,
      sectionName: sectionName(rs.shndx),
      visibility: STV[rs.other & 3] ?? 'default',
      imported,
    };
    symbols.push(sym);
  }
  const imports = symbols.filter((s) => s.imported && s.name);
  const exports = symbols.filter(
    (s) => s.sectionIndex !== 0 && s.bind !== 'local' && (s.type === 'function' || s.type === 'object'),
  );
  return { symbols, imports, exports };
}

/** Extract printable ASCII strings (length >= 4) from allocated non-exec sections. */
function parseStrings(sections: Section[]): StringEntry[] {
  const out: StringEntry[] = [];
  for (const s of sections) {
    if (s.type === SHT.NOBITS) continue;
    if (!(s.flags & SHF_ALLOC)) continue;
    if (s.flags & SHF_EXECINSTR) continue; // strings in code handled via xrefs, avoids noise
    if (s.type !== SHT.PROGBITS && s.type !== SHT.STRTAB) continue;
    const data = s.data;
    let runStart = -1;
    for (let i = 0; i <= data.length; i++) {
      const b = i < data.length ? data[i] : 0;
      const printable = b >= 0x20 && b < 0x7f;
      if (printable && runStart < 0) runStart = i;
      if ((!printable || i === data.length) && runStart >= 0) {
        const len = i - runStart;
        if (len >= 4) {
          out.push({
            addr: s.addr + runStart,
            sectionName: s.name,
            value: new TextDecoder().decode(data.subarray(runStart, i)),
          });
        }
        runStart = -1;
      }
    }
  }
  return out;
}

function parseRelocs(
  r: ByteReader,
  h: ElfHeader,
  sections: Section[],
  symbols: Symbol[],
  arch: Arch,
): Relocation[] {
  const out: Relocation[] = [];
  const typeTable = arch === 'x86_64' ? R_X86_64 : R_AARCH64;
  // Symbol table per reloc section: sh_link points at the associated symtab.
  // Build a flat ordered list per symtab section to resolve r_info symbol index.
  const symtabOrdered = new Map<number, Symbol[]>();
  const getSymtab = (link: number): Symbol[] => {
    let list = symtabOrdered.get(link);
    if (list) return list;
    const symSec = sections[link];
    list = [];
    if (symSec && (symSec.type === SHT.SYMTAB || symSec.type === SHT.DYNSYM)) {
      const strtab = sections[symSec.link];
      const count = Math.floor(symSec.size / 24);
      for (let i = 0; i < count; i++) {
        const base = symSec.offset + i * 24;
        const nameOff = r.u32(base, h.littleEndian);
        const info = r.u8(base + 4);
        const other = r.u8(base + 5);
        const shndx = r.u16(base + 6, h.littleEndian);
        const value = r.u64n(base + 8, h.littleEndian);
        const size = r.u64n(base + 16, h.littleEndian);
        const name = strtab ? readCStr(strtab.data, nameOff) : '';
        list.push({
          name,
          value,
          size,
          type: STT_NAMES[info & 0xf] ?? 'notype',
          bind: (info >> 4) === 1 ? 'global' : (info >> 4) === 2 ? 'weak' : 'local',
          sectionIndex: shndx,
          sectionName: shndx === 0 ? 'UND' : sections[shndx]?.name ?? `SHN_${shndx}`,
          visibility: STV[other & 3] ?? 'default',
          imported: shndx === 0,
        });
      }
    }
    symtabOrdered.set(link, list);
    return list;
  };

  for (const s of sections) {
    if (s.type !== SHT.RELA && s.type !== SHT.REL) continue;
    const target = sections[s.info];
    const syms = getSymtab(s.link);
    const entsize = s.type === SHT.RELA ? 24 : 16;
    const count = Math.floor(s.size / entsize);
    for (let i = 0; i < count; i++) {
      const base = s.offset + i * entsize;
      const addr = r.u64n(base, h.littleEndian);
      const info = r.u64(base + 8, h.littleEndian);
      const type = Number(info & 0xffffffffn);
      const symIdx = Number(info >> 32n);
      const addend = s.type === SHT.RELA ? r.i64(base + 16, h.littleEndian) : 0n;
      const symName = syms[symIdx]?.name ?? '';
      out.push({
        addr,
        type,
        typeName: typeTable[type] ?? `R_${arch}_${type}`,
        symbolName: symName,
        addend,
        sectionName: target?.name ?? '',
      });
    }
  }
  return out;
}

function parseBuildId(r: ByteReader, h: ElfHeader, sections: Section[]): string | undefined {
  for (const s of sections) {
    if (s.type !== SHT.NOTE || s.size < 16) continue;
    // notesz(namesz), descsz, type; name "GNU\0"; desc starts build-id.
    const namesz = r.u32(s.offset, h.littleEndian);
    const descsz = r.u32(s.offset + 4, h.littleEndian);
    const type = r.u32(s.offset + 8, h.littleEndian);
    if (type !== 3) continue;
    const name = new TextDecoder().decode(s.data.subarray(12, 12 + namesz)).replace(/\0+$/, '');
    if (name !== 'GNU') continue;
    const namePad = Math.ceil(namesz / 4) * 4;
    const descOff = s.offset + 12 + namePad;
    const hex = Array.from(r.slice(descOff, descsz))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return hex;
  }
  return undefined;
}

/** Translate a virtual address to (section, file offset). */
export function vaddrToSection(sections: Section[], addr: number): Section | undefined {
  return sections.find(
    (s) => s.flags & SHF_ALLOC && addr >= s.addr && addr < s.addr + s.size && s.type !== SHT.NOBITS,
  );
}

export function vaddrToOffset(sections: Section[], addr: number): number | undefined {
  const s = vaddrToSection(sections, addr);
  if (!s) return undefined;
  return s.offset + (addr - s.addr);
}

export const ELF_CONST = { SHT, SHF_WRITE, SHF_ALLOC, SHF_EXECINSTR };
