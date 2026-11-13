// YARA-subset scanner tests against real ELF samples.
import { readFileSync } from 'node:fs';
import { analyzeBinary } from '../src/core/analysis';
import { parseRules, scanBinary } from '../src/core/yara';
import type { ScanRule } from '../src/core/types';

const bin = analyzeBinary(
  new Uint8Array(readFileSync('samples/bin/fw.clang.x86_64.O0.rel.unstripped.o')),
  'b', 'fw.o',
);
const assert = (cond: boolean, msg: string) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

// 1. Parser: strings, hex, meta, condition operators.
const rules: ScanRule[] = [
  {
    identifier: 'text_match',
    source: `rule text_match { strings: $a = "patchdiff" condition: $a }`,
  },
  {
    identifier: 'hex_wildcard',
    source: `rule hex_wildcard { strings: $h = { 55 48 89 e5 } condition: $h }`,
  },
  {
    identifier: 'hex_jump',
    source: `rule hex_jump { strings: $j = { 55 [1-4] 89 e5 } condition: $j }`,
  },
  {
    identifier: 'quantifier',
    source: `rule quantifier { strings: $a = "fw" $b = "crc" condition: any of them }`,
  },
  {
    identifier: 'count_and_filesize',
    source: `rule count_and_filesize { strings: $a = "fw" condition: #a >= 1 and filesize > 100 }`,
  },
  {
    identifier: 'nocase',
    source: `rule nocase { strings: $a = "PATCHDIFF" nocase condition: $a }`,
  },
];

const parsed = parseRules(rules.map((r) => r.source).join('\n\n'));
assert(parsed.length === 6, `parsed 6 rules, got ${parsed.length}`);
assert(parsed[0].strings[0].kind === 'text', 'first rule has text string');
assert(parsed[1].strings[0].kind === 'hex', 'second rule has hex string');

const hits = scanBinary(bin, rules);
const hitNames = new Set(hits.map((h) => h.rule));
for (const name of ['text_match', 'hex_wildcard', 'hex_jump', 'quantifier', 'count_and_filesize', 'nocase']) {
  assert(hitNames.has(name), `rule ${name} should match`);
}

// 2. Negative case: a rule that must not match.
const neg = scanBinary(bin, [{
  identifier: 'absent',
  source: `rule absent { strings: $a = "definitely_not_present_xyz" condition: $a }`,
}]);
assert(neg.length === 0, 'absent string must not match');

// 3. A64 sample scan too (cross-arch byte scanning).
const a64 = analyzeBinary(
  new Uint8Array(readFileSync('samples/bin/fw.clang.aarch64.O2.rel.unstripped.o')),
  'a', 'fw-a64.o',
);
const a64Hits = scanBinary(a64, [{
  identifier: 'a64_text',
  source: `rule a64_text { strings: $s = "patchdiff" condition: $s }`,
}]);
assert(a64Hits.length === 1, 'A64 sample should contain the version string');

console.log(`YARA: ${hits.length} hits across ${rules.length} rules, all assertions passed`);
