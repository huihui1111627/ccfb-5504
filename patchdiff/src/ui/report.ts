// Diff report export: machine-readable JSON and an analyst-facing Markdown
// summary with per-function change detail.
import type { AnalyzedBinary, FuncDiff } from '../core/types';
import type { DiffResult } from '../core/differ';

export function exportJson(oldBin: AnalyzedBinary, newBin: AnalyzedBinary, diff: DiffResult): string {
  return JSON.stringify({
    generated: new Date().toISOString(),
    old: { file: oldBin.fileName, arch: oldBin.arch, type: oldBin.type, functions: oldBin.functions.length },
    new: { file: newBin.fileName, arch: newBin.arch, type: newBin.type, functions: newBin.functions.length },
    stats: diff.stats,
    functions: diff.diffs.map((d) => ({
      old: d.match.oldName ?? null,
      new: d.match.newName ?? null,
      status: d.match.status,
      score: Number(d.match.score.toFixed(3)),
      similarity: Number(d.similarity.toFixed(3)),
      reason: d.match.reason,
      changes: d.changeSummary,
    })),
  }, null, 2);
}

export function exportMarkdown(oldBin: AnalyzedBinary, newBin: AnalyzedBinary, diff: DiffResult): string {
  const lines: string[] = [];
  lines.push(`# Patch Diff Report`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`| | Old | New |`);
  lines.push(`|---|---|---|`);
  lines.push(`| File | \`${oldBin.fileName}\` | \`${newBin.fileName}\` |`);
  lines.push(`| Arch | ${oldBin.arch} | ${newBin.arch} |`);
  lines.push(`| Functions | ${oldBin.functions.length} | ${newBin.functions.length} |`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`- Matched: ${diff.stats.matched}`);
  lines.push(`- Added: ${diff.stats.added}`);
  lines.push(`- Removed: ${diff.stats.removed}`);
  lines.push(`- Renamed: ${diff.stats.renamed}`);
  lines.push(`- Modified: ${diff.stats.modified}`);
  lines.push(`- Unchanged: ${diff.stats.unchanged}`);
  lines.push('');
  lines.push(`## Changed Functions (ranked by churn)`);
  lines.push('');
  lines.push(`| Function | Status | Similarity | +added | -removed | ~modified | Why matched |`);
  lines.push(`|---|---|---:|---:|---:|---:|---|`);
  for (const d of diff.diffs) {
    const name = d.match.oldName ?? d.match.newName ?? '?';
    lines.push(`| ${name} | ${d.match.status} | ${d.similarity.toFixed(2)} | ${d.changeSummary.added} | ${d.changeSummary.removed} | ${d.changeSummary.modified} | ${d.match.reason} |`);
  }
  lines.push('');
  // Detailed block-level view for the functions that actually changed.
  const changed = diff.diffs.filter((d) => d.similarity < 1);
  if (changed.length) {
    lines.push(`## Block-Level Detail`);
    lines.push('');
    for (const d of changed) {
      const name = d.match.oldName ?? d.match.newName ?? '?';
      lines.push(`### ${name}`);
      for (const block of d.changes) {
        if (block.kind === 'unchanged') continue;
        lines.push(`**${block.kind.toUpperCase()}** block`);
        lines.push('```');
        for (const row of block.rows) {
          if (row.kind === 'added') lines.push(`+ ${row.newInst?.text ?? ''}`);
          else if (row.kind === 'removed') lines.push(`- ${row.oldInst?.text ?? ''}`);
          else if (row.kind === 'modified') {
            lines.push(`- ${row.oldInst?.text ?? ''}`);
            lines.push(`+ ${row.newInst?.text ?? ''}`);
          }
        }
        lines.push('```');
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function summarizeDiff(d: FuncDiff): string {
  const c = d.changeSummary;
  return `+${c.added} -${c.removed} ~${c.modified}`;
}
