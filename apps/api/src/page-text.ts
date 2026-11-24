// A fetched web page's bytes as text in the page's own charset (public-fetch.ts, website import).

/**
 * The charset a page names: the Content-Type header, else a `<meta charset>` or `<meta http-equiv>` in its first
 * 2 kB (HTML's own rule). '' when it names none.
 */
export function declaredCharset(contentType: string, bytes: Uint8Array): string {
  const fromHeader = /charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1]
  if (fromHeader) return fromHeader
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1')
  return /<meta[^>]+charset\s*=\s*["']?([^"'\s/>;]+)/i.exec(head)?.[1] ?? ''
}

/**
 * A page's bytes as text in its own charset, so a German site in ISO-8859-1 keeps its "ä" (as UTF-8 it would be
 * "\uFFFD"). A page that names none is UTF-8 when it is valid UTF-8, else Windows-1252 (what browsers fall back to).
 * A cut body (`truncated`) drops a letter cut in half at the end instead of ending in "\uFFFD".
 */
export function decodePage(bytes: Uint8Array, contentType: string, truncated = false): string {
  const charset = declaredCharset(contentType, bytes)
  let decoder: TextDecoder | null = null
  try {
    if (charset) decoder = new TextDecoder(charset)
  } catch {
    decoder = null // a name Node does not know: guess as for none
  }
  decoder ??= new TextDecoder(isUtf8(bytes, truncated) ? 'utf-8' : 'windows-1252')
  const text = decoder.decode(bytes, { stream: truncated })
  // A page that says UTF-8 but is not (an old CMS behind a new server): Windows-1252, not a page full of "\uFFFD".
  if (decoder.encoding === 'utf-8' && text.includes('\uFFFD') && !isUtf8(bytes, truncated))
    return new TextDecoder('windows-1252').decode(bytes)
  return text
}

function isUtf8(bytes: Uint8Array, truncated: boolean): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated })
    return true
  } catch {
    return false
  }
}
