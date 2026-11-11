// The text of a PDF, read in a worker thread with a memory limit and a time limit (pdf-text-worker.ts),
// so a decompression bomb or a PDF of thousands of pages costs one worker, never the API's main thread.
import { Worker } from 'node:worker_threads'

/** Pages read from one PDF; the rest is left out. */
export const PDF_MAX_PAGES = 200
export const PDF_TIMEOUT_MS = 20_000
const PDF_MEMORY_MB = 256

export type PdfText = { text: string; truncated: boolean }
/** The PDF could not be read in time or within memory: refused with a sentence for the owner. */
export class PdfRefused extends Error {}

export function pdfText(bytes: Uint8Array, maxChars: number): Promise<PdfText> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-text-worker.ts', import.meta.url), {
      workerData: { bytes, maxPages: PDF_MAX_PAGES, maxChars },
      resourceLimits: { maxOldGenerationSizeMb: PDF_MEMORY_MB, maxYoungGenerationSizeMb: 32 },
    })
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new PdfRefused('That PDF takes too long to read.'))),
      PDF_TIMEOUT_MS,
    )
    worker.once('message', (m: { ok: true; text: string; truncated: boolean } | { ok: false }) =>
      finish(() =>
        m.ok
          ? resolve({ text: m.text, truncated: m.truncated })
          : reject(new PdfRefused('That PDF could not be read. Is it protected by a password?')),
      ),
    )
    // Out of memory ends the worker with ERR_WORKER_OUT_OF_MEMORY.
    worker.once('error', () => finish(() => reject(new PdfRefused('That PDF is too large to read.'))))
    worker.once('exit', () => finish(() => reject(new PdfRefused('That PDF could not be read.'))))
  })
}
