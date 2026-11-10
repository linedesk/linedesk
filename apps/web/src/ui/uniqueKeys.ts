/** React keys for a list of texts that may repeat: the second "Call back" becomes "Call back#2". */
export function uniqueKeys(texts: string[]): string[] {
  const seen = new Map<string, number>()
  return texts.map(text => {
    const count = (seen.get(text) ?? 0) + 1
    seen.set(text, count)
    return count === 1 ? text : `${text}#${count}`
  })
}
