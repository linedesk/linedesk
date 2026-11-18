// Where a dialog's focus starts (form.tsx, dialogStart): the first field, never the ✕ in the head, whose focus ring
// stood out on a provider with its keys stored (Server admin › Providers › Edit).
import { expect, test } from 'vitest'
import { dialogStart } from './form.tsx'

/** A stand-in for the DOM parts dialogStart reads: an element with a parent, found by class or by the selectors used. */
type Node = {
  name: string
  classes: string[]
  parent: Node | null
  children: Node[]
  field?: boolean
  primary?: boolean
}
function el(name: string, classes: string[] = [], extra: Partial<Node> = {}, children: Node[] = []): Node {
  const node: Node = { name, classes, parent: null, children, ...extra }
  for (const child of children) child.parent = node
  return node
}
const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)]
function asElement(n: Node): HTMLElement {
  return {
    name: n.name,
    contains: (other: { name: string } | null) => !!other && all(n).some(m => m.name === other.name),
    closest: (selector: string) => {
      for (let at: Node | null = n; at; at = at.parent) if (at.classes.includes(selector.slice(1))) return asElement(at)
      return null
    },
    querySelector: (selector: string) => {
      const found = all(n)
        .slice(1)
        .find(m =>
          selector.startsWith('.k-dialog-body')
            ? m.classes.includes('k-dialog-body')
            : selector.startsWith(':is(input')
              ? m.field
              : m.primary,
        )
      return found ? asElement(found) : null
    },
  } as unknown as HTMLElement
}
const nameOf = (e: HTMLElement | null) => (e as unknown as { name: string } | null)?.name ?? null

function dialog(body: Node[]) {
  const close = el('close', ['k-btn'])
  const head = el('head', ['k-dialog-head'], {}, [close])
  const save = el('save', ['k-btn-primary'], { primary: true })
  const foot = el('foot', ['k-dialog-foot'], {}, [save])
  const box = el('box', ['k-dialog'], {}, [head, el('body', ['k-dialog-body'], {}, body), foot])
  const find = (name: string) => asElement(all(box).find(m => m.name === name)!)
  return { box: asElement(box), find }
}

test('the first field of the body, also when the backdrop put the focus on the ✕', () => {
  const d = dialog([el('key', [], { field: true })])
  expect(nameOf(dialogStart(d.box, d.find('close')))).toBe('key')
})

test('nothing to type (a provider with its keys stored): the dialog itself, never the ✕ in the head', () => {
  const d = dialog([el('words')])
  expect(nameOf(dialogStart(d.box, d.find('close')))).toBe('box')
  expect(nameOf(dialogStart(d.box, null))).toBe('box')
})

test('a field that has the focus already keeps it, and so does a footer button that took it itself', () => {
  const d = dialog([el('key', [], { field: true })])
  expect(dialogStart(d.box, d.find('key'))).toBeNull()
  const words = dialog([el('words')])
  expect(dialogStart(words.box, words.find('save'))).toBeNull()
})
