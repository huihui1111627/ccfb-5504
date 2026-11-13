// Typed promise wrapper around the analysis Web Worker.
import type { AnalyzedBinary, ScanHit, ScanRule } from '../core/types';
import type { DiffResult } from '../core/differ';
import type { WorkerRequest, WorkerResponse } from '../workers/analyze.worker';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/analyze.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      // Responses are correlated by payload content; we use a simple queue since
      // all jobs are strictly request/response. Match via the most recent waiter.
      const handler = pending.values().next().value;
      if (!handler) return;
      const firstKey = pending.keys().next().value!;
      pending.delete(firstKey);
      const msg = ev.data;
      if (msg.kind === 'error') handler.reject(new Error(msg.error));
      else handler.resolve(msg);
    };
    worker.onerror = (e) => {
      for (const { reject } of pending.values()) reject(new Error(e.message));
      pending.clear();
    };
  }
  return worker;
}

function call(req: WorkerRequest): Promise<WorkerResponse> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage(req);
  });
}

export async function analyzeFile(fileName: string, bytes: Uint8Array, id: string): Promise<AnalyzedBinary> {
  const resp = await call({ kind: 'analyze', id, fileName, bytes: bytes.buffer.slice(0) as ArrayBuffer });
  if (resp.kind !== 'analyzed') throw new Error('unexpected worker response');
  return resp.binary;
}

export async function diffFiles(
  oldSpec: { id: string; fileName: string; bytes: Uint8Array },
  newSpec: { id: string; fileName: string; bytes: Uint8Array },
): Promise<DiffResult> {
  const resp = await call({
    kind: 'diff',
    oldId: oldSpec.id,
    newId: newSpec.id,
    binaries: {
      [oldSpec.id]: { fileName: oldSpec.fileName, bytes: oldSpec.bytes.buffer.slice(0) as ArrayBuffer },
      [newSpec.id]: { fileName: newSpec.fileName, bytes: newSpec.bytes.buffer.slice(0) as ArrayBuffer },
    },
  });
  if (resp.kind !== 'diff') throw new Error('unexpected worker response');
  return resp.result;
}

export async function scanFile(fileName: string, bytes: Uint8Array, id: string, rules: ScanRule[]): Promise<ScanHit[]> {
  const resp = await call({ kind: 'scan', binaryId: id, fileName, bytes: bytes.buffer.slice(0) as ArrayBuffer, rules });
  if (resp.kind !== 'scan') throw new Error('unexpected worker response');
  return resp.hits;
}
