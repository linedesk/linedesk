// Just enough XML for WebDAV multistatus answers: elements by local name (servers pick their own prefixes: d:, D:,
// none), their text with entities and CDATA decoded. No DTDs, no external entities: nothing is fetched or expanded.
// The server is the member's, so it may be hostile: one pass over the text (no backtracking regex), a size cap and a
// depth cap, so no answer can hold up the API's event loop or its stack.
export type XmlNode = { name: string; attrs: Record<string, string>; children: XmlNode[]; text: string }

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1))
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[ref] ?? whole
  })
}

const localName = (qualified: string) => qualified.slice(qualified.indexOf(':') + 1)

/** Larger answers are refused (the adapter reads at most 2 MB, the guarded fetch 5 MB). */
export const MAX_XML_CHARS = 2_000_000
/** Elements in one answer: a calendar's events over a few weeks are a few thousand; this keeps the tree small in memory. */
export const MAX_XML_ELEMENTS = 50_000
/** WebDAV answers nest a handful of levels; far deeper is no answer we read. */
const MAX_DEPTH = 64

const isSpace = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r'

/** A start tag's inside ("d:comp name='VEVENT'") as its name and attributes, in one pass. */
function readTag(tag: string): { name: string; attrs: Record<string, string> } {
  let i = 0
  while (i < tag.length && !isSpace(tag[i])) i++
  const name = localName(tag.slice(0, i))
  const attrs: Record<string, string> = {}
  while (i < tag.length) {
    while (isSpace(tag[i])) i++
    const keyStart = i
    while (i < tag.length && tag[i] !== '=' && !isSpace(tag[i])) i++
    const key = tag.slice(keyStart, i)
    while (isSpace(tag[i])) i++
    if (!key || tag[i] !== '=') break
    i++
    while (isSpace(tag[i])) i++
    const quote = tag[i]
    if (quote !== '"' && quote !== "'") break
    const end = tag.indexOf(quote, i + 1)
    if (end < 0) break
    attrs[localName(key)] = decode(tag.slice(i + 1, end))
    i = end + 1
  }
  return { name, attrs }
}

/** The document's root element; throws on markup it cannot read. */
export function parseXml(xml: string): XmlNode {
  if (xml.length > MAX_XML_CHARS) throw new Error('XML answer too large')
  const root: XmlNode = { name: '#document', attrs: {}, children: [], text: '' }
  const stack = [root]
  const top = () => stack[stack.length - 1]!
  /** Where `token` ends after `from`; unterminated markup is unreadable. */
  const past = (token: string, from: number) => {
    const at = xml.indexOf(token, from)
    if (at < 0) throw new Error('unreadable XML')
    return at + token.length
  }
  let elements = 0
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) break
    if (lt > i) top().text += decode(xml.slice(i, lt))
    if (xml.startsWith('<!--', lt)) {
      i = past('-->', lt)
    } else if (xml.startsWith('<![CDATA[', lt)) {
      i = past(']]>', lt)
      top().text += xml.slice(lt + 9, i - 3)
    } else if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      i = past('>', lt)
    } else if (xml[lt + 1] === '/') {
      i = past('>', lt)
      const name = localName(xml.slice(lt + 2, i - 1).trim())
      if (stack.length > 1 && top().name === name) stack.pop()
    } else {
      // Attribute values may hold '>': skip quoted parts.
      let end = lt + 1
      let quote: string | null = null
      for (; end < xml.length; end++) {
        const c = xml[end]
        if (quote) {
          if (c === quote) quote = null
        } else if (c === '"' || c === "'") quote = c
        else if (c === '>') break
      }
      if (end >= xml.length) throw new Error('unreadable XML')
      const inner = xml.slice(lt + 1, end)
      const selfClosing = inner.endsWith('/')
      const { name, attrs } = readTag((selfClosing ? inner.slice(0, -1) : inner).trim())
      const node: XmlNode = { name, attrs, children: [], text: '' }
      if (++elements > MAX_XML_ELEMENTS) throw new Error('XML answer has too many elements')
      top().children.push(node)
      if (!selfClosing) stack.push(node)
      if (stack.length > MAX_DEPTH) throw new Error('XML nested too deeply')
      i = end + 1
    }
  }
  const element = root.children[0]
  if (!element) throw new Error('no XML element')
  return element
}

/** The first child (depth first, at any depth) with this local name. */
export function find(node: XmlNode | undefined, name: string): XmlNode | undefined {
  if (!node) return undefined
  for (const child of node.children) {
    if (child.name === name) return child
    const deeper = find(child, name)
    if (deeper) return deeper
  }
  return undefined
}

export const childrenNamed = (node: XmlNode | undefined, name: string) =>
  node?.children.filter(c => c.name === name) ?? []

/** Every descendant with this local name. */
export function findAll(node: XmlNode | undefined, name: string): XmlNode[] {
  if (!node) return []
  return node.children.flatMap(child => (child.name === name ? [child] : findAll(child, name)))
}

export const textOf = (node: XmlNode | undefined) => node?.text.trim() ?? ''
