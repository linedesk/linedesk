// Detects a deploy while a tab is open: the build's entry script has a content hash in its name
// (/assets/index-<hash>.js), so a different name in the served index.html means a newer build.
const ENTRY_SCRIPT = /<script[^>]+src="(\/assets\/[^"]+\.js)"/

/** The entry script's path in an index.html, or null when there is none (dev server). */
export function entryScriptOf(html: string): string | null {
  return ENTRY_SCRIPT.exec(html)?.[1] ?? null
}

/** True when the served page loads a different entry script than the running one. */
export function isNewVersion(running: string | null, servedHtml: string): boolean {
  const served = entryScriptOf(servedHtml)
  return running !== null && served !== null && running !== served
}

/** The entry script this tab was loaded with, from its own document. */
export function runningEntryScript(doc: Document = document): string | null {
  const script = doc.querySelector<HTMLScriptElement>('script[type="module"][src^="/assets/"]')
  return script?.getAttribute('src') ?? null
}
