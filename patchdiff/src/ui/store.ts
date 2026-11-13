// Central application store. Holds the imported binaries, annotations, saved
// rule sets and diff results. Annotations and binaries persist to localStorage
// so renames survive a reload; raw file bytes are kept in memory only.
import type { AnalyzedBinary, Annotation, ScanRule } from '../core/types';
import type { DiffResult } from '../core/differ';

interface StoredAnnotation {
  binaryId: string;
  addr: number;
  kind: 'name' | 'comment';
  value: string;
}

const STORE_KEY = 'patchdiff.state.v1';

interface Persisted {
  annotations: StoredAnnotation[];
  rules: ScanRule[];
}

export interface BinaryEntry {
  binary: AnalyzedBinary;
  bytes: Uint8Array;
}

class AppStore {
  binaries = new Map<string, BinaryEntry>();
  annotations: Annotation[] = [];
  rules: ScanRule[] = [];
  diff: DiffResult | null = null;
  diffPair: { oldId: string; newId: string } | null = null;
  private listeners = new Set<() => void>();

  constructor() {
    this.load();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((fn) => fn());
  }

  addBinary(binary: AnalyzedBinary, bytes: Uint8Array): void {
    this.binaries.set(binary.id, { binary, bytes });
    this.emit();
  }

  removeBinary(id: string): void {
    this.binaries.delete(id);
    this.annotations = this.annotations.filter((a) => a.binaryId !== id);
    this.emit();
    this.persist();
  }

  rename(binaryId: string, addr: number, name: string): void {
    this.annotations = this.annotations.filter(
      (a) => !(a.binaryId === binaryId && a.addr === addr && a.kind === 'name'),
    );
    this.annotations.push({ binaryId, addr, kind: 'name', value: name });
    this.applyAnnotations();
    this.emit();
    this.persist();
  }

  comment(binaryId: string, addr: number, text: string): void {
    this.annotations = this.annotations.filter(
      (a) => !(a.binaryId === binaryId && a.addr === addr && a.kind === 'comment'),
    );
    if (text) this.annotations.push({ binaryId, addr, kind: 'comment', value: text });
    this.applyAnnotations();
    this.emit();
    this.persist();
  }

  /** Overlay saved names/comments onto the in-memory function names. */
  private applyAnnotations(): void {
    for (const entry of this.binaries.values()) {
      const byAddr = new Map<number, Function>();
      for (const f of entry.binary.functions) byAddr.set(f.addr, f as unknown as Function);
      for (const a of this.annotations) {
        if (a.binaryId !== entry.binary.id) continue;
        const fn = entry.binary.functions.find((f) => f.addr === a.addr);
        if (!fn) continue;
        if (a.kind === 'name') (fn as { name: string }).name = a.value;
      }
      void byAddr;
    }
  }

  setRules(rules: ScanRule[]): void {
    this.rules = rules;
    this.emit();
    this.persist();
  }

  setDiff(result: DiffResult, oldId: string, newId: string): void {
    this.diff = result;
    this.diffPair = { oldId, newId };
    this.emit();
  }

  private persist(): void {
    const data: Persisted = {
      annotations: this.annotations.map((a) => ({ ...a })),
      rules: this.rules,
    };
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch {
      // storage may be unavailable (private mode); annotations stay in memory.
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as Persisted;
      this.annotations = data.annotations ?? [];
      this.rules = data.rules ?? [];
    } catch {
      // ignore corrupt state
    }
  }
}

export const store = new AppStore();
