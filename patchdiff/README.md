# PatchDiff Workbench

A fully browser-side binary patch-diffing workbench for firmware security
auditing. Import an ELF, recover its functions, browse disassembly and
control-flow graphs, diff two firmware versions (including stripped builds),
and scan with a YARA-subset rule engine — all locally in a Web Worker, with no
server-side analysis.

## Why

Vendor patch notes rarely say which function changed. This tool takes two
builds of a firmware object and tells you:

* which functions were added, removed, renamed or modified;
* how similar each matched function is and why it was matched;
* the exact added/removed/modified instructions at block level.

It implements its own ELF parser and x86-64 / AArch64 disassemblers from
scratch — no external disassembly library is shipped to the browser.

## Capabilities

| Area | Implementation |
|---|---|
| ELF parsing | Sections, symbols, imports/exports, relocations, strings, `.note.gnu.build-id` |
| x86-64 disassembler | REX/VEX, ModRM/SIB, legacy + SSE/SSE2..SSE4.1, control/string/system groups; AT&T and Intel syntax |
| AArch64 disassembler | Move-wide, add/sub/logical (imm & reg), bitfield/EXTR, load/store families, branches, conditional select, variable shifts |
| Function recovery | Symbol-driven when present; `.eh_frame` FDE + relocation + prologue heuristics when stripped |
| Control-flow graph | Basic blocks from branch targets/terminators, successor/predecessor edges, SVG rendering |
| Cross references | call/jump/data/pointer xrefs, click-to-navigate |
| Function matching | Name pass then feature pass (mnemonic multiset, CFG shape, constants, callees, string refs, fuzzy hash); works on stripped pairs |
| Diff | Instruction LCS alignment, block-level add/remove/modify tags, churn ranking, similarity scoring |
| Rule scanner | YARA subset: text/hex strings, wildcards, byte jumps, nocase/wide, `any/all/N of`, `#`/`@` refs, boolean/arithmetic conditions |
| Annotations | Inline rename/comment, persisted to `localStorage` |
| Reports | JSON and Markdown export |
| Threading | All analysis runs in a Web Worker |

## Quick start

```bash
npm install
npm run samples          # build the cross-arch corpus (clang, O0/O2, stripped)
npm run dev              # open the printed localhost URL
```

Then use **Sample Library → import** on files from `samples/bin/`.

## Verification

The disassemblers are validated against the system `objdump` (LLVM on macOS,
GNU on Linux). The conformance harness compares instruction boundaries and
rendered text across the entire corpus:

```bash
npm run test:conformance   # 5198 instructions, byte-length + text agreement
npm run test:diff           # 8 arch/opt/strip configurations, ground-truth checked
npm run test:yara           # parser + matcher unit checks
npm run test:e2e            # Playwright UI → Worker → engine end-to-end
```

Current result on the bundled corpus: **100% conformance, zero length errors,
zero text mismatches** across x86-64 and AArch64, O0/O2, stripped/unstripped.

### Stripped-binary matching

The stripped corpus is produced by the project's own TypeScript ELF stripper
(`scripts/strip-elf.ts`), which removes `.symtab`/`.strtab` while keeping
relocations and `.eh_frame`. Function recovery then uses `.eh_frame` FDE
initial-location relocations (which survive a normal strip) plus call-target
and prologue signals. Every recovered function in the test corpus maps back to
the correct unstripped symbol — the diff test asserts this explicitly.

## Project layout

```
src/core/elf.ts              ELF(64) parser
src/core/x64/                x86-64 tables, decoder, renderers
src/core/aarch64/decoder.ts  AArch64 decoder
src/core/analysis.ts         function recovery, CFG, xrefs, features
src/core/differ.ts           matching, LCS alignment, block diff
src/core/yara.ts             rule parser + byte matcher
src/workers/analyze.worker.ts  off-main-thread analysis
src/ui/                      hash-routed five-page SPA
scripts/build-samples.sh     corpus builder (clang, both arches, O0/O2)
scripts/strip-elf.ts         dependency-free ELF stripper
tests/                       conformance, diff, yara, e2e suites
```

## Sample corpus

`samples/src/fw.c` and `fw_patched.c` model a small firmware component with a
CRC routine, header validation, key mixing, logging and command dispatch. The
"patched" variant introduces realistic fixes (extra bounds checks, a corrected
shift constant, a new command) so the diff pipeline has ground-truth changes to
find, including functions that changed and helpers that did not.
