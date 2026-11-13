// YARA-syntax-subset scanner.
//
// Supported rule grammar (the subset that firmware triage actually uses):
//
//   rule NAME [ : tag ... ] {
//     meta: key = "value" ...
//     strings:
//       $id = "text" [nocase] [wide|ascii]
//       $id = { AA BB ?? CC [2-4] DD }
//     condition:
//       <expr>
//   }
//
// Condition expressions support: $id, #id, @id, @id[N], integer literals,
// string literals, filesize, math/comparison operators, and/or/not,
// parentheses, "any/all/n of them", "any/all of ($a,$b)", "$id at offset".

import type { AnalyzedBinary, Bytes, ScanHit, ScanRule } from './types';

// ---------------- parser ----------------

export interface YaraString {
  id: string;
  kind: 'text' | 'hex';
  value: string;
  hexTokens?: HexToken[];
  nocase: boolean;
  wide: boolean;
  ascii: boolean;
}

type HexToken =
  | { kind: 'byte'; value: number; wildcard: boolean; highNib: boolean }
  | { kind: 'jump'; min: number; max: number };

export interface ParsedRule {
  identifier: string;
  tags: string[];
  strings: YaraString[];
  condition: CondNode;
  source: string;
}

type CondNode =
  | { kind: 'ident-ref'; id: string }            // $a
  | { kind: 'count-ref'; id: string }            // #a
  | { kind: 'offset-ref'; id: string; index?: number } // @a, @a[1]
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'filesize' }
  | { kind: 'at'; id: string; offset: number }
  | { kind: 'of-them'; quant: 'any' | 'all' | number }
  | { kind: 'of-list'; quant: 'any' | 'all' | number; ids: string[] }
  | { kind: 'unop'; op: 'not' | '-'; e: CondNode }
  | { kind: 'binop'; op: string; l: CondNode; r: CondNode };

class RuleParseError extends Error {}

class Lexer {
  pos = 0;
  constructor(readonly src: string) {}

  skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        this.pos++;
      } else if (c === '/' && this.src[this.pos + 1] === '/') {
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
      } else if (c === '/' && this.src[this.pos + 1] === '*') {
        this.pos += 2;
        while (this.pos < this.src.length && !(this.src[this.pos] === '*' && this.src[this.pos + 1] === '/')) this.pos++;
        this.pos += 2;
      } else break;
    }
  }

  peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? '';
  }

  consume(lit: string): boolean {
    this.skipWs();
    if (this.src.startsWith(lit, this.pos)) {
      this.pos += lit.length;
      return true;
    }
    return false;
  }

  expect(lit: string): void {
    if (!this.consume(lit)) throw new RuleParseError(`expected "${lit}" at ${this.pos}: ${this.snippet()}`);
  }

  private snippet(): string {
    return this.src.slice(this.pos, this.pos + 24).replace(/\s+/g, ' ');
  }

  readWord(): string {
    this.skipWs();
    const start = this.pos;
    while (this.pos < this.src.length && /[A-Za-z0-9_]/.test(this.src[this.pos])) this.pos++;
    return this.src.slice(start, this.pos);
  }

  readQuoted(): string {
    this.skipWs();
    const quote = this.src[this.pos];
    if (quote !== '"') throw new RuleParseError(`expected string at ${this.pos}`);
    this.pos++;
    let out = '';
    while (this.pos < this.src.length && this.src[this.pos] !== quote) {
      const c = this.src[this.pos++];
      if (c === '\\' && this.pos < this.src.length) {
        const e = this.src[this.pos++];
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e === '\\' ? '\\' : e === '"' ? '"' : e;
      } else {
        out += c;
      }
    }
    this.pos++;
    return out;
  }

  readNumber(): number {
    this.skipWs();
    const start = this.pos;
    if (this.src[this.pos] === '0' && (this.src[this.pos + 1] === 'x' || this.src[this.pos + 1] === 'X')) {
      this.pos += 2;
      while (this.pos < this.src.length && /[0-9a-fA-F]/.test(this.src[this.pos])) this.pos++;
      return parseInt(this.src.slice(start + 2, this.pos), 16);
    }
    while (this.pos < this.src.length && /[0-9]/.test(this.src[this.pos])) this.pos++;
    const mult = this.src[this.pos] === 'K' || this.src[this.pos] === 'M' ? this.src[this.pos++] : '';
    const n = Number(this.src.slice(start, this.pos - (mult ? 1 : 0)));
    return mult === 'K' ? n * 1024 : mult === 'M' ? n * 1024 * 1024 : n;
  }
}

function parseHexString(src: string): HexToken[] {
  const tokens: HexToken[] = [];
  const lex = new Lexer(src);
  lex.expect('{');
  for (;;) {
    lex.skipWs();
    if (lex.consume('}')) break;
    if (lex.consume('[')) {
      const min = lex.readNumber();
      let max = min;
      lex.skipWs();
      if (lex.consume('-')) max = lex.readNumber();
      lex.expect(']');
      tokens.push({ kind: 'jump', min, max });
      continue;
    }
    const c1 = lex.src[lex.pos];
    if (c1 === '?') {
      lex.pos++;
      if (lex.src[lex.pos] === '?') lex.pos++;
      tokens.push({ kind: 'byte', value: 0, wildcard: true, highNib: true });
      continue;
    }
    if (/[0-9a-fA-F]/.test(c1)) {
      const high = lex.src[lex.pos++];
      if (lex.src[lex.pos] === '?') {
        lex.pos++;
        tokens.push({ kind: 'byte', value: parseInt(high, 16) << 4, wildcard: true, highNib: false });
        continue;
      }
      const low = lex.src[lex.pos++];
      if (!/[0-9a-fA-F]/.test(low)) throw new RuleParseError('bad hex nibble');
      tokens.push({ kind: 'byte', value: parseInt(high + low, 16), wildcard: false, highNib: false });
      continue;
    }
    throw new RuleParseError(`bad hex token at: ${lex.src.slice(lex.pos, lex.pos + 8)}`);
  }
  return tokens;
}

function parseRule(src: string): ParsedRule {
  const lex = new Lexer(src);
  lex.expect('rule');
  const identifier = lex.readWord();
  if (!identifier) throw new RuleParseError('missing rule identifier');
  const tags: string[] = [];
  if (lex.consume(':')) {
    for (;;) {
      const t = lex.readWord();
      if (t) tags.push(t);
      if (!lex.consume(',')) break;
    }
  }
  lex.expect('{');
  const ystrings: YaraString[] = [];
  let condition: CondNode | undefined;

  for (;;) {
    lex.skipWs();
    if (lex.pos >= lex.src.length) break;
    if (lex.consume('}')) break;
    const section = lex.readWord();
    if (!section) break;
    lex.expect(':');
    if (section === 'meta') {
      // Skip until next section keyword or closing brace.
      skipSection(lex);
    } else if (section === 'strings') {
      while (lex.peek() === '$') {
        lex.pos++;
        const id = lex.readWord();
        lex.expect('=');
        if (lex.peek() === '{') {
          const hexSrc = '{' + lex.src.slice(lex.pos + 1).split('}')[0] + '}';
          lex.pos += hexSrc.length;
          ystrings.push({ id, kind: 'hex', value: '', hexTokens: parseHexString(hexSrc), nocase: false, wide: false, ascii: true });
        } else {
          const text = lex.readQuoted();
          let nocase = false;
          let wide = false;
          let ascii = true;
          for (;;) {
            const mod = lex.readWord();
            if (!mod) break;
            // Stop at the next section keyword rather than swallowing it.
            if (mod === 'condition' || mod === 'meta' || mod === 'strings') {
              lex.pos -= mod.length;
              break;
            }
            if (mod === 'nocase') nocase = true;
            else if (mod === 'wide') wide = true;
            else if (mod === 'ascii') ascii = true;
          }
          ystrings.push({ id, kind: 'text', value: text, nocase, wide, ascii });
        }
      }
    } else if (section === 'condition') {
      condition = parseCondition(lex);
      lex.skipWs();
      lex.consume('}');
      break;
    } else {
      throw new RuleParseError(`unknown section "${section}"`);
    }
  }
  if (!condition) throw new RuleParseError('rule missing condition');
  return { identifier, tags, strings: ystrings, condition, source: src };
}

function skipSection(lex: Lexer): void {
  let depth = 0;
  while (lex.pos < lex.src.length) {
    const c = lex.src[lex.pos];
    if (c === '{') depth++;
    if (c === '}') {
      if (depth === 0) {
        lex.pos--; // let main loop consume it
        return;
      }
      depth--;
    }
    if (depth === 0 && /[a-z]/.test(c) && (lex.src.slice(lex.pos).startsWith('strings') || lex.src.slice(lex.pos).startsWith('condition'))) {
      // next section begins
      const rest = lex.src.slice(lex.pos);
      if (/^(strings|condition)\s*:/.test(rest)) return;
    }
    lex.pos++;
  }
}

// Condition expression parser (precedence climbing).
const BIN_PRECEDENCE: Record<string, number> = {
  or: 1, and: 2,
  '==': 4, '!=': 4, '<': 4, '<=': 4, '>': 4, '>=': 4,
  '|': 5, '^': 6, '&': 7,
  '<<': 8, '>>': 8,
  '+': 9, '-': 9, '*': 10, '\\': 10, '%': 10,
};

function parseCondition(lex: Lexer): CondNode {
  const expr = parseBinary(lex, 0);
  return expr;
}

function parseBinary(lex: Lexer, minPrec: number): CondNode {
  let left = parseUnary(lex);
  for (;;) {
    lex.skipWs();
    const mark = lex.pos;
    const op = readOperator(lex);
    if (!op) break;
    const prec = BIN_PRECEDENCE[op];
    if (prec < minPrec) {
      // Lower-precedence operator belongs to an enclosing call; rewind so it
      // can be consumed there rather than swallowed here.
      lex.pos = mark;
      break;
    }
    const right = parseBinary(lex, prec + 1);
    left = { kind: 'binop', op, l: left, r: right };
  }
  return left;
}

function readOperator(lex: Lexer): string | undefined {
  const s = lex.src;
  const two = s.slice(lex.pos, lex.pos + 2);
  if (['==', '!=', '<=', '>=', '<<', '>>'].includes(two)) {
    lex.pos += 2;
    return two;
  }
  const one = s[lex.pos];
  if (['<', '>', '+', '-', '*', '%', '&', '|', '^'].includes(one)) {
    lex.pos += 1;
    return one === '\\' ? '\\' : one;
  }
  const afterWord = (kw: string) => {
    const next = s[lex.pos + kw.length];
    return next === undefined || !/[A-Za-z0-9_]/.test(next);
  };
  if (s.startsWith('or', lex.pos) && afterWord('or')) {
    lex.pos += 2;
    return 'or';
  }
  if (s.startsWith('and', lex.pos) && afterWord('and')) {
    lex.pos += 3;
    return 'and';
  }
  if (s.startsWith('not', lex.pos) && afterWord('not')) {
    lex.pos += 3;
    return 'not';
  }
  return undefined;
}

function parseUnary(lex: Lexer): CondNode {
  lex.skipWs();
  if (lex.consume('not')) return { kind: 'unop', op: 'not', e: parseUnary(lex) };
  if (lex.peek() === '(') {
    lex.expect('(');
    const e = parseBinary(lex, 0);
    lex.expect(')');
    return e;
  }
  return parsePrimary(lex);
}

function parsePrimary(lex: Lexer): CondNode {
  lex.skipWs();
  // String identifiers lead with a sigil and are not valid words, so check for
  // them before consuming a keyword/number token.
  if (lex.peek() === '$' || lex.peek() === '#' || lex.peek() === '@') {
    const sigil = lex.src[lex.pos++];
    const id = lex.readWord();
    if (sigil === '#') return { kind: 'count-ref', id };
    if (sigil === '@') {
      if (lex.consume('[')) {
        const index = lex.readNumber();
        lex.expect(']');
        return { kind: 'offset-ref', id, index };
      }
      return { kind: 'offset-ref', id, index: 1 };
    }
    // $id at offset
    if (lex.readWord() === 'at') {
      const off = lex.readNumber();
      return { kind: 'at', id, offset: off };
    }
    return { kind: 'ident-ref', id };
  }
  // quantifier: any/all/N of (them|list)
  const word = lex.readWord();
  if (word === 'any' || word === 'all') {
    lex.expect('of');
    if (lex.consume('them')) return { kind: 'of-them', quant: word };
    lex.expect('(');
    const ids: string[] = [];
    for (;;) {
      lex.skipWs();
      lex.expect('$');
      ids.push(lex.readWord());
      if (!lex.consume(',')) break;
    }
    lex.expect(')');
    return { kind: 'of-list', quant: word, ids };
  }
  if (word === 'filesize') return { kind: 'filesize' };
  if (word === 'true') return { kind: 'num', value: 1 };
  if (word === 'false') return { kind: 'num', value: 0 };
  if (lex.peek() === '"') return { kind: 'str', value: lex.readQuoted() };
  if (/^[0-9]/.test(word) || word.startsWith('0x')) {
    // A bare numeric literal. The "N of them/list" quantifier is only taken
    // when the token after the number is actually the word "of".
    const savePos = lex.pos;
    const n = Number(word);
    if (lex.readWord() === 'of') {
      if (lex.consume('them')) return { kind: 'of-them', quant: n };
      lex.expect('(');
      const ids: string[] = [];
      for (;;) {
        lex.expect('$');
        ids.push(lex.readWord());
        if (!lex.consume(',')) break;
      }
      lex.expect(')');
      return { kind: 'of-list', quant: n, ids };
    }
    // Not a quantifier: the number was already consumed via `word`, so treat
    // its numeric value directly.
    lex.pos = savePos;
    return { kind: 'num', value: n };
  }
  throw new RuleParseError(`unexpected condition token "${word || lex.peek()}"`);
}

export function parseRules(source: string): ParsedRule[] {
  const rules: ParsedRule[] = [];
  const lex = new Lexer(source);
  for (;;) {
    lex.skipWs();
    if (lex.pos >= lex.src.length) break;
    // Capture the span of one rule and parse it in isolation. We locate the
    // opening "rule" keyword and scan to the matching closing brace, tracking
    // depth so braces inside strings/hex patterns do not confuse the scan.
    if (!lex.consume('rule')) {
      throw new RuleParseError(`expected "rule" at offset ${lex.pos}`);
    }
    const start = lex.pos;
    void start;
    lex.skipWs();
    const identifier = lex.readWord();
    if (!identifier) throw new RuleParseError('missing rule identifier');
    // Find the opening brace, then scan to its matching close.
    lex.skipWs();
    if (lex.consume(':')) {
      for (;;) {
        lex.readWord();
        if (!lex.consume(',')) break;
      }
    }
    lex.expect('{');
    let depth = 1;
    const bodyStart = lex.pos;
    while (lex.pos < lex.src.length && depth > 0) {
      const c = lex.src[lex.pos++];
      if (c === '"') {
        while (lex.pos < lex.src.length && lex.src[lex.pos] !== '"') {
          if (lex.src[lex.pos] === '\\') lex.pos++;
          lex.pos++;
        }
        lex.pos++;
      } else if (c === '{') depth++;
      else if (c === '}') depth--;
    }
    const bodyEnd = lex.pos - 1;
    const chunk = `rule ${identifier} {` + lex.src.slice(bodyStart, bodyEnd) + '}';
    rules.push(parseRule(chunk));
  }
  return rules;
}

// ---------------- matching engine ----------------

function textToBytePatterns(s: YaraString): Bytes[] {
  const enc = new TextEncoder();
  const base = enc.encode(s.nocase ? s.value.toLowerCase() : s.value);
  const out: Bytes[] = [];
  if (s.ascii || (!s.wide)) out.push(base);
  if (s.wide) {
    const wide = new Uint8Array(base.length * 2);
    base.forEach((b, i) => {
      wide[i * 2] = b;
      wide[i * 2 + 1] = 0;
    });
    out.push(wide);
  }
  return out;
}

function matchHexAt(data: Bytes, pos: number, tokens: HexToken[]): boolean {
  let p = pos;
  for (const t of tokens) {
    if (t.kind === 'jump') {
      // handled by recursive driver below
      return false;
    }
    if (p >= data.length) return false;
    const b = data[p];
    if (!t.wildcard && b !== t.value) return false;
    if (t.wildcard && !t.highNib && (b & 0xf0) !== (t.value & 0xf0)) return false;
    p++;
  }
  return true;
}

function* hexMatches(data: Bytes, tokens: HexToken[]): Generator<number> {
  // Split on jumps; match segments with bounded gaps via backtracking.
  const segments: HexToken[][] = [[]];
  const jumps: Array<{ min: number; max: number }> = [];
  for (const t of tokens) {
    if (t.kind === 'jump') {
      jumps.push({ min: t.min, max: t.max });
      segments.push([]);
    } else {
      segments[segments.length - 1].push(t);
    }
  }
  const first = segments[0];
  for (let pos = 0; pos < data.length; pos++) {
    if (matchHexAt(data, pos, first)) {
      let cursor = pos + first.length;
      let ok = true;
      for (let si = 1; si < segments.length; si++) {
        const j = jumps[si - 1];
        const seg = segments[si];
        let found = false;
        for (let gap = j.min; gap <= j.max && cursor + gap + seg.length <= data.length; gap++) {
          if (matchHexAt(data, cursor + gap, seg)) {
            cursor = cursor + gap + seg.length;
            found = true;
            break;
          }
        }
        if (!found) {
          ok = false;
          break;
        }
      }
      if (ok) yield pos;
    }
  }
}

function* textMatches(data: Bytes, patterns: Uint8Array[], nocase: boolean): Generator<number> {
  for (let pos = 0; pos < data.length; pos++) {
    for (const pat of patterns) {
      if (pos + pat.length > data.length) continue;
      let hit = true;
      for (let k = 0; k < pat.length; k++) {
        let a = data[pos + k];
        const b = pat[k];
        if (nocase && a >= 0x41 && a <= 0x5a) a += 0x20;
        if (a !== b) {
          hit = false;
          break;
        }
      }
      if (hit) yield pos;
    }
  }
}

interface StringMatches {
  ids: Map<string, number[]>; // id -> hit offsets
}

function evaluate(node: CondNode, matches: StringMatches, fileSize: number): boolean {
  switch (node.kind) {
    case 'num': return node.value !== 0;
    case 'str': return false;
    case 'filesize': return fileSize !== 0;
    case 'ident-ref': return (matches.ids.get(node.id)?.length ?? 0) > 0;
    case 'count-ref': return (matches.ids.get(node.id)?.length ?? 0) > 0;
    case 'offset-ref': {
      const hits = matches.ids.get(node.id);
      return !!hits && hits.length >= (node.index ?? 1);
    }
    case 'at': return (matches.ids.get(node.id) ?? []).includes(node.offset);
    case 'of-them': {
      const all = [...matches.ids.values()];
      const hitCount = all.filter((h) => h.length > 0).length;
      return node.quant === 'any' ? hitCount > 0 : node.quant === 'all' ? hitCount === all.length && all.length > 0 : hitCount >= node.quant;
    }
    case 'of-list': {
      const hitCount = node.ids.filter((id) => (matches.ids.get(id)?.length ?? 0) > 0).length;
      return node.quant === 'any' ? hitCount > 0 : node.quant === 'all' ? hitCount === node.ids.length : hitCount >= node.quant;
    }
    case 'unop':
      return node.op === 'not' ? !evaluate(node.e, matches, fileSize) : false;
    case 'binop': {
      // Short-circuit logical ops.
      if (node.op === 'and') return evaluate(node.l, matches, fileSize) && evaluate(node.r, matches, fileSize);
      if (node.op === 'or') return evaluate(node.l, matches, fileSize) || evaluate(node.r, matches, fileSize);
      const lv = evalInt(node.l, matches, fileSize);
      const rv = evalInt(node.r, matches, fileSize);
      switch (node.op) {
        case '==': return lv === rv;
        case '!=': return lv !== rv;
        case '<': return lv < rv;
        case '<=': return lv <= rv;
        case '>': return lv > rv;
        case '>=': return lv >= rv;
        case '+': return (lv + rv) !== 0;
        case '-': return (lv - rv) !== 0;
        default: return false;
      }
    }
  }
}

function evalInt(node: CondNode, matches: StringMatches, fileSize: number): number {
  switch (node.kind) {
    case 'num': return node.value;
    case 'filesize': return fileSize;
    case 'count-ref': return matches.ids.get(node.id)?.length ?? 0;
    case 'offset-ref': {
      const hits = matches.ids.get(node.id);
      const i = (node.index ?? 1) - 1;
      return hits && hits[i] !== undefined ? hits[i] : -1;
    }
    case 'binop': {
      const l = evalInt(node.l, matches, fileSize);
      const r = evalInt(node.r, matches, fileSize);
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '\\':
        case '%': return r === 0 ? 0 : Math.trunc(l / r);
        case '&': return l & r;
        case '|': return l | r;
        case '^': return l ^ r;
        case '<<': return l << r;
        case '>>': return l >> r;
        default: return evaluate(node, matches, fileSize) ? 1 : 0;
      }
    }
    case 'unop': return -evalInt(node.e, matches, fileSize);
    default: return evaluate(node, matches, fileSize) ? 1 : 0;
  }
}

// ---------------- public API ----------------

export function scanBinary(bin: AnalyzedBinary, rules: ScanRule[]): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const rule of rules) {
    let parsed: ParsedRule[];
    try {
      parsed = parseRules(rule.source);
    } catch (e) {
      throw new Error(`rule "${rule.identifier}" parse error: ${(e as Error).message}`);
    }
    for (const pr of parsed) {
      const sm: StringMatches = { ids: new Map() };
      let firstHit = -1;
      const hitStrings: string[] = [];
      for (const ys of pr.strings) {
        const offsets: number[] = [];
        if (ys.kind === 'hex' && ys.hexTokens) {
          for (const off of hexMatches(bin.fileBytes, ys.hexTokens)) offsets.push(off);
        } else {
          const pats = textToBytePatterns(ys);
          for (const off of textMatches(bin.fileBytes, pats, ys.nocase)) offsets.push(off);
        }
        sm.ids.set(ys.id, offsets);
        if (offsets.length && firstHit < 0) {
          firstHit = offsets[0];
          hitStrings.push(ys.value || `$${ys.id}`);
        }
      }
      if (evaluate(pr.condition, sm, bin.fileBytes.length)) {
        const off = firstHit < 0 ? 0 : firstHit;
        const slice = bin.fileBytes.subarray(off, off + 32);
        hits.push({
          rule: pr.identifier,
          binaryId: bin.id,
          fileName: bin.fileName,
          addr: off,
          matchedData: Array.from(slice).map((b) => b.toString(16).padStart(2, '0')).join(' '),
          strings: hitStrings,
        });
      }
    }
  }
  return hits;
}
