// Binary-level differ: function matching across two versions (robust to
// stripping), change ranking, and block-level LCS alignment.

import type {
  AnalyzedBinary, BlockChange, FuncDiff, FuncFeatures, FuncMatch,
  Function_, Instruction, InstDiffRow,
} from './types';

export interface DiffResult {
  matches: FuncMatch[];
  diffs: FuncDiff[];
  stats: {
    total: number;
    matched: number;
    added: number;
    removed: number;
    renamed: number;
    modified: number;
    unchanged: number;
  };
}

// ---------------- matching ----------------

interface Candidate {
  oldFn: Function_;
  newFn: Function_;
  score: number;
  reason: string;
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / new Set([...sa, ...sb]).size;
}

function numOverlap(a: number[], b: number[]): number {
  const sb = new Set(b);
  let n = 0;
  for (const x of a) if (sb.has(x)) n++;
  return n;
}

/** 0..1 similarity between feature sets; deliberately multi-signal so that
 *  stripped binaries still match when any one signal is weak. */
export function featureScore(a: FuncFeatures, b: FuncFeatures): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let total = 0;
  let weight = 0;

  // Mnemonic multiset cosine — strongest single signal for re-compiled code.
  const keys = new Set([...Object.keys(a.mnemonicCounts), ...Object.keys(b.mnemonicCounts)]);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const x = a.mnemonicCounts[k] ?? 0;
    const y = b.mnemonicCounts[k] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const cosine = na && nb ? dot / Math.sqrt(na * nb) : 0;
  total += cosine * 4;
  weight += 4;
  if (cosine > 0.95) reasons.push('mnemonic multiset ~identical');

  // Size proximity.
  const sizeSim = a.numInsts && b.numInsts
    ? 1 - Math.min(1, Math.abs(a.numInsts - b.numInsts) / Math.max(a.numInsts, b.numInsts))
    : 0;
  total += sizeSim * 2;
  weight += 2;

  // Structure: block / branch / call counts.
  const blockSim = a.numBlocks && b.numBlocks
    ? 1 - Math.min(1, Math.abs(a.numBlocks - b.numBlocks) / Math.max(a.numBlocks, b.numBlocks))
    : 0;
  total += blockSim;
  weight += 1;
  if (blockSim > 0.9) reasons.push('same CFG shape');

  // Callee names — strong when symbols exist, ignored for imports-only cases.
  const calleeJ = jaccard(a.calleeNames, b.calleeNames);
  if (a.calleeNames.length || b.calleeNames.length) {
    total += calleeJ * 3;
    weight += 3;
    if (calleeJ > 0.8) reasons.push('shared callees');
  }
  // Constants.
  const constSim = (a.constants.length || b.constants.length)
    ? numOverlap(a.constants, b.constants) / new Set([...a.constants, ...b.constants]).size
    : 0;
  if (a.constants.length || b.constants.length) {
    total += constSim * 2;
    weight += 2;
    if (constSim > 0.7) reasons.push('shared constants');
  }
  // String references.
  const strSim = (a.stringRefs.length || b.stringRefs.length)
    ? numOverlap(a.stringRefs, b.stringRefs) / new Set([...a.stringRefs, ...b.stringRefs]).size
    : 0;
  if (a.stringRefs.length || b.stringRefs.length) {
    total += strSim * 3;
    weight += 3;
    if (strSim > 0.7) reasons.push('shared strings');
  }
  // Fuzzy hash token overlap.
  if (a.fuzzyHash && b.fuzzyHash) {
    const tok = new Set(a.fuzzyHash.split(''));
    const tok2 = b.fuzzyHash.split('');
    const inter = tok2.filter((t) => tok.has(t)).length;
    const fh = inter / Math.max(1, new Set(tok2).size);
    total += fh * 2;
    weight += 2;
  }
  return { score: weight ? total / weight : 0, reasons };
}

function normalizeName(name: string): string {
  // sub_xxxx / func_xxxx placeholders compare by structure instead of name.
  return name.replace(/^(sub|func|fcn)_[0-9a-fA-F]+$/, '').replace(/\.(isra|\d+)+$/, '').replace(/constprop\.\d+/, '');
}

export function matchFunctions(oldBin: AnalyzedBinary, newBin: AnalyzedBinary): FuncMatch[] {
  const oldFns = oldBin.functions;
  const newFns = newBin.functions;
  const matches: FuncMatch[] = [];
  const usedNew = new Set<number>();

  // Pass 1: identical names (symbol present in both).
  const newByName = new Map<string, Function_>();
  for (const nf of newFns) {
    const key = normalizeName(nf.name);
    if (key && !newByName.has(key)) newByName.set(key, nf);
  }
  for (const ofn of oldFns) {
    const key = normalizeName(ofn.name);
    const nf = key ? newByName.get(key) : undefined;
    if (nf && !usedNew.has(nf.addr)) {
      usedNew.add(nf.addr);
      const renamed = ofn.name !== nf.name;
      matches.push({
        oldAddr: ofn.addr,
        newAddr: nf.addr,
        oldName: ofn.name,
        newName: nf.name,
        score: 1,
        reason: renamed ? 'name match (renamed)' : 'symbol name match',
        status: renamed ? 'renamed' : 'matched',
      });
    }
  }

  // Pass 2: feature-based Hungarian-lite greedy matching for the rest.
  const unmatchedOld = oldFns.filter((f) => !matches.some((m) => m.oldAddr === f.addr));
  const unmatchedNew = newFns.filter((f) => !usedNew.has(f.addr));
  const candidates: Candidate[] = [];
  for (const ofn of unmatchedOld) {
    for (const nfn of unmatchedNew) {
      if (Math.abs(ofn.features.numInsts - nfn.features.numInsts) > Math.max(8, ofn.features.numInsts * 2)) continue;
      const { score, reasons } = featureScore(ofn.features, nfn.features);
      if (score >= 0.55) candidates.push({ oldFn: ofn, newFn: nfn, score, reason: reasons.join('; ') || 'feature similarity' });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const cand of candidates) {
    if (matches.some((m) => m.oldAddr === cand.oldFn.addr) || usedNew.has(cand.newFn.addr)) continue;
    usedNew.add(cand.newFn.addr);
    const renamed = cand.oldFn.name !== cand.newFn.name &&
      (cand.oldFn.recovered || cand.newFn.recovered);
    matches.push({
      oldAddr: cand.oldFn.addr,
      newAddr: cand.newFn.addr,
      oldName: cand.oldFn.name,
      newName: cand.newFn.name,
      score: cand.score,
      reason: cand.reason,
      status: renamed ? 'renamed' : 'matched',
    });
  }

  // Pass 3: added/removed.
  const matchedOld = new Set(matches.map((m) => m.oldAddr));
  const matchedNew = new Set(matches.map((m) => m.newAddr));
  for (const ofn of oldFns) {
    if (!matchedOld.has(ofn.addr)) {
      matches.push({ oldAddr: ofn.addr, oldName: ofn.name, score: 0, reason: 'only in old version', status: 'removed' });
    }
  }
  for (const nfn of newFns) {
    if (!matchedNew.has(nfn.addr)) {
      matches.push({ newAddr: nfn.addr, newName: nfn.name, score: 0, reason: 'only in new version', status: 'added' });
    }
  }
  return matches;
}

// ---------------- instruction-level alignment ----------------

/** Normalize an instruction for LCS: mnemonic + operand shapes, dropping
 *  absolute immediates so relocated code still aligns. */
function normKey(inst: Instruction): string {
  const ops = inst.operands
    .map((o) => {
      if (o.kind === 'reg' || o.kind === 'fp-reg' || o.kind === 'sysreg') return `R:${o.reg}`;
      if (o.kind === 'imm') return 'I';
      if (o.kind === 'mem') {
        const m = o.mem!;
        return `M:${m.base ?? ''}:${m.index ?? ''}:${m.scale ?? 1}`;
      }
      return o.kind;
    })
    .join(',');
  return `${inst.mnemonic}(${ops})`;
}

/** Semantic signature deciding whether two shape-equal instructions are truly
 *  unchanged. Branch targets, RIP-relative addresses and reloc annotations move
 *  with layout and must not count as edits; real immediate/constant changes do.
 *  A normalized text suffix is appended so details not modeled as structured
 *  operands (A64 shift amounts, extend operators) still participate. */
function semanticKey(inst: Instruction): string {
  const ops = inst.operands
    .map((o) => {
      if (o.kind === 'reg' || o.kind === 'fp-reg' || o.kind === 'sysreg') return `R:${o.reg}`;
      if (o.kind === 'imm') {
        // Branch/call targets are layout-dependent, not semantic edits.
        if (inst.flow === 'direct-jump' || inst.flow === 'conditional-jump' || inst.flow === 'call') return 'I:TARGET';
        return `I:${o.imm!.toString()}`;
      }
      if (o.kind === 'mem') {
        const m = o.mem!;
        // RIP-relative target addresses relocate; keep the displacement shape only.
        if (m.ripTarget !== undefined) return `M:${m.base ?? ''}:RIP`;
        return `M:${m.base ?? ''}:${m.index ?? ''}:${m.scale ?? 1}:${m.disp?.toString() ?? '0'}`;
      }
      return o.kind;
    })
    .join(',');
  // Text with branch-target hex and RIP targets blanked, so layout movement
  // does not create false modifications but constant/shift edits still do.
  const textSig = inst.text
    .replace(/0x[0-9a-f]+ <[^>]*>/g, 'TGT')
    .replace(/\b0x[0-9a-f]+\b/g, (h) =>
      inst.flow === 'direct-jump' || inst.flow === 'conditional-jump' || inst.flow === 'call' ? 'TGT' : h);
  return `${inst.mnemonic}(${ops})|${textSig}`;
}

/** Classic LCS table over normalized instructions. */
function lcsTable(a: Instruction[], b: Instruction[]): number[][] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      if (normKey(a[i]) === normKey(b[j])) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function alignInsts(oldInsts: Instruction[], newInsts: Instruction[]): InstDiffRow[] {
  const dp = lcsTable(oldInsts, newInsts);
  const rows: InstDiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < oldInsts.length && j < newInsts.length) {
    if (normKey(oldInsts[i]) === normKey(newInsts[j])) {
      const kind = semanticKey(oldInsts[i]) === semanticKey(newInsts[j]) ? 'unchanged' : 'modified';
      rows.push({ oldInst: oldInsts[i], newInst: newInsts[j], kind });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ oldInst: oldInsts[i], kind: 'removed' });
      i++;
    } else {
      rows.push({ newInst: newInsts[j], kind: 'added' });
      j++;
    }
  }
  while (i < oldInsts.length) rows.push({ oldInst: oldInsts[i++], kind: 'removed' });
  while (j < newInsts.length) rows.push({ newInst: newInsts[j++], kind: 'added' });
  return rows;
}

/** Group aligned instruction rows into block changes keyed by block start. */
function blockChanges(oldFn: Function_ | undefined, newFn: Function_ | undefined): BlockChange[] {
  const changes: BlockChange[] = [];
  if (!oldFn && newFn) {
    return [{ kind: 'added', newStart: newFn.entry, rows: newFn.insts.map((newInst) => ({ newInst, kind: 'added' as const })), similarity: 0 }];
  }
  if (oldFn && !newFn) {
    return [{ kind: 'removed', oldStart: oldFn.entry, rows: oldFn.insts.map((oldInst) => ({ oldInst, kind: 'removed' as const })), similarity: 0 }];
  }
  if (!oldFn || !newFn) return changes;

  // Align whole functions, then split rows at block boundaries.
  const rows = alignInsts(oldFn.insts, newFn.insts);
  const oldStarts = new Set(oldFn.blocks.map((b) => b.start));
  const newStarts = new Set(newFn.blocks.map((b) => b.start));
  let current: InstDiffRow[] = [];
  let curOldStart: number | undefined;
  let curNewStart: number | undefined;
  const flush = () => {
    if (current.length === 0) return;
    const kinds = new Set(current.map((r) => r.kind));
    let kind: BlockChange['kind'] = 'unchanged';
    if (kinds.has('added') || kinds.has('removed') || kinds.has('modified')) kind = 'modified';
    const sameCount = current.filter((r) => r.kind === 'unchanged').length;
    changes.push({
      kind,
      oldStart: curOldStart,
      newStart: curNewStart,
      rows: current,
      similarity: sameCount / current.length,
    });
    current = [];
  };
  for (const row of rows) {
    const oldStart = row.oldInst?.addr;
    const newStart = row.newInst?.addr;
    const boundary = (oldStart !== undefined && oldStarts.has(oldStart)) ||
      (newStart !== undefined && newStarts.has(newStart));
    if (boundary && current.length) flush();
    if (boundary) {
      curOldStart = oldStart ?? curOldStart;
      curNewStart = newStart ?? curNewStart;
    }
    if (current.length === 0) {
      curOldStart = oldStart;
      curNewStart = newStart;
    }
    current.push(row);
  }
  flush();
  return changes;
}

function overallSimilarity(rows: InstDiffRow[]): number {
  if (rows.length === 0) return 1;
  const same = rows.filter((r) => r.kind === 'unchanged').length;
  return same / rows.length;
}

// ---------------- driver ----------------

export function diffBinaries(oldBin: AnalyzedBinary, newBin: AnalyzedBinary): DiffResult {
  const matches = matchFunctions(oldBin, newBin);
  const oldByAddr = new Map(oldBin.functions.map((f) => [f.addr, f]));
  const newByAddr = new Map(newBin.functions.map((f) => [f.addr, f]));

  const diffs: FuncDiff[] = [];
  for (const match of matches) {
    const oldFn = match.oldAddr !== undefined ? oldByAddr.get(match.oldAddr) : undefined;
    const newFn = match.newAddr !== undefined ? newByAddr.get(match.newAddr) : undefined;
    if (match.status === 'added' || match.status === 'removed') {
      const changes = blockChanges(oldFn, newFn);
      diffs.push({
        match,
        changes,
        similarity: match.status === 'added' || match.status === 'removed' ? 0 : 1,
        changeSummary: {
          added: changes.reduce((n, c) => n + c.rows.filter((r) => r.kind === 'added').length, 0),
          removed: changes.reduce((n, c) => n + c.rows.filter((r) => r.kind === 'removed').length, 0),
          modified: changes.reduce((n, c) => n + c.rows.filter((r) => r.kind === 'modified').length, 0),
        },
      });
      continue;
    }
    const rows = alignInsts(oldFn!.insts, newFn!.insts);
    const changes = blockChanges(oldFn, newFn);
    const similarity = overallSimilarity(rows);
    const diff: FuncDiff = {
      match,
      changes,
      similarity,
      changeSummary: {
        added: rows.filter((r) => r.kind === 'added').length,
        removed: rows.filter((r) => r.kind === 'removed').length,
        modified: rows.filter((r) => r.kind === 'modified').length,
      },
    };
    diffs.push(diff);
  }

  // Ranking: biggest churn first, then added/removed, then similarity asc.
  diffs.sort((a, b) => {
    const churn = (d: FuncDiff) => d.changeSummary.added + d.changeSummary.removed + d.changeSummary.modified;
    const ca = churn(a);
    const cb = churn(b);
    if (cb !== ca) return cb - ca;
    return a.similarity - b.similarity;
  });

  // A "paired" function is one present in both binaries (matched or renamed
  // across stripped builds). Modified/unchanged counts span both statuses.
  const paired = (d: FuncDiff) => d.match.status === 'matched' || d.match.status === 'renamed';
  const stats = {
    total: matches.length,
    matched: matches.filter((m) => m.status === 'matched').length,
    added: matches.filter((m) => m.status === 'added').length,
    removed: matches.filter((m) => m.status === 'removed').length,
    renamed: matches.filter((m) => m.status === 'renamed').length,
    modified: diffs.filter((d) => paired(d) && d.similarity < 1).length,
    unchanged: diffs.filter((d) => paired(d) && d.similarity === 1).length,
  };
  return { matches, diffs, stats };
}
