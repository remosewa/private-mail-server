/**
 * Singleton wrapper around the embedding Web Worker.
 * Queues requests and resolves them as Promise<Float32Array[]>.
 */

const DIMS = 384;

type Pending = {
  resolve: (vecs: Float32Array[]) => void;
  reject: (err: Error) => void;
};

class EmbedderClient {
  private worker: Worker;
  private pending = new Map<number, Pending>();
  private _nextId = 0;
  private _modelReady = false;
  private _readyListeners: (() => void)[] = [];

  constructor() {
    this.worker = new Worker(
      new URL('./embedder.worker.ts', import.meta.url),
      { type: 'module' },
    );

    this.worker.addEventListener('message', (e: MessageEvent) => {
      const { id, buffer, count, error } = e.data as {
        id: number;
        buffer?: ArrayBuffer;
        count?: number;
        error?: string;
      };
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);

      if (error) {
        p.reject(new Error(error));
        return;
      }

      const src = new Float32Array(buffer!);
      const vecs: Float32Array[] = [];
      for (let i = 0; i < count!; i++) {
        vecs.push(src.slice(i * DIMS, (i + 1) * DIMS));
      }

      if (!this._modelReady) {
        this._modelReady = true;
        this._readyListeners.forEach(fn => fn());
        this._readyListeners = [];
      }

      p.resolve(vecs);
    });

    this.worker.addEventListener('error', (e: ErrorEvent) => {
      const err = new Error(e.message);
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.reject(err);
      }
    });
  }

  /** Embed a batch of texts. Returns one 384-dim unit vector per text. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, texts });
    });
  }

  get modelReady(): boolean {
    return this._modelReady;
  }

  /** Resolves when the model finishes loading (first inference complete). */
  onModelReady(): Promise<void> {
    if (this._modelReady) return Promise.resolve();
    return new Promise(resolve => this._readyListeners.push(resolve));
  }

  terminate() {
    this.worker.terminate();
  }
}

let _client: EmbedderClient | null = null;

export function getEmbedderClient(): EmbedderClient {
  if (!_client) _client = new EmbedderClient();
  return _client;
}
