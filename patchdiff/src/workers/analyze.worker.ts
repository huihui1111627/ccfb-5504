// Web Worker: all heavy analysis runs off the main thread. The UI posts file
// bytes and job descriptors; results come back as structured-cloneable data.
/// <reference lib="webworker" />
import { analyzeBinary } from '../core/analysis';
import { diffBinaries } from '../core/differ';
import { scanBinary } from '../core/yara';
import type { AnalyzedBinary, ScanHit, ScanRule } from '../core/types';
import type { DiffResult } from '../core/differ';

export type WorkerRequest =
  | { kind: 'analyze'; id: string; fileName: string; bytes: ArrayBuffer }
  | { kind: 'diff'; oldId: string; newId: string; binaries: Record<string, { fileName: string; bytes: ArrayBuffer }> }
  | { kind: 'scan'; binaryId: string; fileName: string; bytes: ArrayBuffer; rules: ScanRule[] };

export type WorkerResponse =
  | { kind: 'analyzed'; id: string; binary: AnalyzedBinary }
  | { kind: 'diff'; result: DiffResult }
  | { kind: 'scan'; hits: ScanHit[] }
  | { kind: 'error'; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  try {
    if (req.kind === 'analyze') {
      const binary = analyzeBinary(new Uint8Array(req.bytes), req.id, req.fileName);
      const resp: WorkerResponse = { kind: 'analyzed', id: req.id, binary };
      ctx.postMessage(resp);
    } else if (req.kind === 'diff') {
      const bins: Record<string, AnalyzedBinary> = {};
      for (const [id, spec] of Object.entries(req.binaries)) {
        bins[id] = analyzeBinary(new Uint8Array(spec.bytes), id, spec.fileName);
      }
      const result = diffBinaries(bins[req.oldId], bins[req.newId]);
      const resp: WorkerResponse = { kind: 'diff', result };
      ctx.postMessage(resp);
    } else if (req.kind === 'scan') {
      const binary = analyzeBinary(new Uint8Array(req.bytes), req.binaryId, req.fileName);
      const hits = scanBinary(binary, req.rules);
      const resp: WorkerResponse = { kind: 'scan', hits };
      ctx.postMessage(resp);
    }
  } catch (e) {
    const resp: WorkerResponse = { kind: 'error', error: (e as Error).message };
    ctx.postMessage(resp);
  }
};
