// Reads the text of an uploaded PDF in a worker thread (pdf-text.ts starts it with a memory limit and
// kills it after a time limit), so a hostile or huge PDF can never block the API's main thread. Reads at
// most `maxPages` pages and stops once it has `maxChars` characters.
import { parentPort, workerData } from 'node:worker_threads'
import { getDocumentProxy } from 'unpdf'

type Input = { bytes: Uint8Array; maxPages: number; maxChars: number }

async function read({ bytes, maxPages, maxChars }: Input) {
  const pdf = await getDocumentProxy(bytes)
  const pages = Math.min(pdf.numPages, maxPages)
  let text = ''
  let truncated = pdf.numPages > maxPages
  for (let n = 1; n <= pages; n++) {
    const page = await pdf.getPage(n)
    const content = await page.getTextContent()
    text += `${content.items.map(item => ('str' in item ? item.str : '')).join(' ')}\n\n`
    page.cleanup()
    if (text.length > maxChars) {
      truncated = true
      break
    }
  }
  return { text: text.slice(0, maxChars), truncated }
}

read(workerData as Input).then(
  result => parentPort!.postMessage({ ok: true, ...result }),
  () => parentPort!.postMessage({ ok: false }),
)
