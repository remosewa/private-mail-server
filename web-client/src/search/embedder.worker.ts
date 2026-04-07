/**
 * Embedding Web Worker — loads Xenova/all-MiniLM-L6-v2 via @huggingface/transformers
 * (ONNX Runtime Web under the hood) and responds to embed requests.
 *
 * Message in:  { id: number, texts: string[] }
 * Message out: { id: number, buffer: ArrayBuffer, count: number }
 *              buffer = Float32Array of shape [count, 384] (transferable)
 */

import { env } from '@huggingface/transformers';

env.allowLocalModels = false;

const MODEL = 'Xenova/all-MiniLM-L6-v2';
const DIMS = 384;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedder: any = null;

async function getEmbedder() {
  if (!embedder) {
    // Dynamic import avoids the complex union return type that TS can't represent
    const { pipeline } = await import('@huggingface/transformers');
    // Try WebGPU with fp32 (q8 isn't well-supported on WebGPU and causes CPU fallback).
    // Falls back to q8 WASM if WebGPU is unavailable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embedder = await (pipeline as any)('feature-extraction', MODEL, { dtype: 'fp32', device: 'webgpu' })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .catch(() => (pipeline as any)('feature-extraction', MODEL, { dtype: 'q8' }));
  }
  return embedder;
}

self.addEventListener('message', async (event: MessageEvent<{ id: number; texts: string[] }>) => {
  const { id, texts } = event.data;
  try {
    const pipe = await getEmbedder();
    const isWebGpu = pipe.device === 'webgpu' || pipe.session?.handler?.backend === 'webgpu';

    // On WebGPU: pass all chunks in one call (no OOM risk, sub-batching adds overhead).
    // On WASM: sub-batch at 32 to avoid OOM with large inputs.
    const SUB_BATCH = isWebGpu ? texts.length : 32;
    const buffer = new Float32Array(texts.length * DIMS);

    for (let i = 0; i < texts.length; i += SUB_BATCH) {
      const slice = texts.slice(i, i + SUB_BATCH);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const output: any = await pipe(slice, { pooling: 'mean', normalize: true });
      buffer.set(output.data as Float32Array, i * DIMS);
    }

    // Transfer the buffer to avoid copying
    const transferable = new Float32Array(buffer);
    (self as unknown as Worker).postMessage({ id, buffer: transferable.buffer, count: texts.length }, [transferable.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
});
