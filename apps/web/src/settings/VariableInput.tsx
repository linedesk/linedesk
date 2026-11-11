// A one-line text field whose variables ({first_name}) show as pills: one solid piece that the caret moves
// around and Backspace removes whole. Buttons below insert a variable at the caret. The value stays plain
// text with the {key} placeholders, so what is stored and checked is the same as before.
import { type ClipboardEvent, type KeyboardEvent, useLayoutEffect, useRef } from 'react'
import { Button, cx, Icon } from '../ui/kit.tsx'

export type Variable = { key: string; label: string }
/** `at`: where the variable starts in the text. */
type Segment = { text: string } | { variable: Variable; at: number }

/** Zero-width space: gives the caret a place next to a pill at the start or end of the line. Never stored. */
const CARET_SPOT = '​'

/** The text cut into plain parts and the variables it uses ({first_name}, any case, spaces inside the braces). */
export function segmentsOf(value: string, variables: readonly Variable[]): Segment[] {
  if (!variables.length) return value ? [{ text: value }] : []
  const pattern = new RegExp(`\\{\\s*(${variables.map(v => v.key).join('|')})\\s*\\}`, 'gi')
  const segments: Segment[] = []
  let at = 0
  for (const match of value.matchAll(pattern)) {
    if (match.index > at) segments.push({ text: value.slice(at, match.index) })
    segments.push({ variable: variables.find(v => v.key === match[1]!.toLowerCase())!, at: match.index })
    at = match.index + match[0].length
  }
  if (at < value.length) segments.push({ text: value.slice(at) })
  return segments
}

const variableOf = (node: Node) => (node instanceof HTMLElement ? node.dataset.variable : undefined)

function pill(variable: Variable): HTMLElement {
  const el = document.createElement('span')
  el.className = 'vt-pill'
  el.contentEditable = 'false'
  el.dataset.variable = variable.key
  el.setAttribute('role', 'img')
  el.setAttribute('aria-label', `${variable.label}, filled in for each caller`)
  el.textContent = variable.label
  return el
}

/** What the field holds, as stored text: pills back to {key}, caret spots and line breaks dropped. */
function serialize(root: HTMLElement): string {
  let out = ''
  for (const node of root.childNodes) {
    const key = variableOf(node)
    out += key ? `{${key}}` : (node.textContent ?? '')
  }
  return out.replaceAll(CARET_SPOT, '').replace(/[\r\n]+/g, ' ')
}

/** Text and pills as nodes, with a caret spot wherever a pill has no text beside it. */
function nodesOf(segments: Segment[]): Node[] {
  const nodes: Node[] = []
  segments.forEach((segment, i) => {
    if ('text' in segment) return nodes.push(document.createTextNode(segment.text))
    if (i === 0 || 'variable' in segments[i - 1]!) nodes.push(document.createTextNode(CARET_SPOT))
    nodes.push(pill(segment.variable))
    if (i === segments.length - 1) nodes.push(document.createTextNode(CARET_SPOT))
  })
  return nodes
}

/** The pill right before (or after) a collapsed caret, skipping caret spots; null when there is none. */
function pillBeside(root: HTMLElement, forward: boolean): HTMLElement | null {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !selection.isCollapsed) return null
  const { startContainer: node, startOffset: offset } = selection.getRangeAt(0)
  let sibling: Node | null
  if (node === root) sibling = root.childNodes[forward ? offset : offset - 1] ?? null
  else {
    const text = node.textContent ?? ''
    const beside = forward ? text.slice(offset) : text.slice(0, offset)
    if (beside.replaceAll(CARET_SPOT, '')) return null
    sibling = forward ? node.nextSibling : node.previousSibling
  }
  while (sibling && !variableOf(sibling) && !(sibling.textContent ?? '').replaceAll(CARET_SPOT, ''))
    sibling = forward ? sibling.nextSibling : sibling.previousSibling
  return sibling && variableOf(sibling) ? (sibling as HTMLElement) : null
}

function placeCaretAfter(node: Node) {
  const range = document.createRange()
  range.setStartAfter(node)
  range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

type Props = {
  id: string
  /** The field's name for assistive technology (the visible label is not tied to a div). */
  label: string
  value: string
  onChange: (value: string) => void
  variables: readonly Variable[]
  placeholder?: string
  invalid?: boolean
  describedBy?: string
}

export function VariableInput({ id, label, value, onChange, variables, placeholder, invalid, describedBy }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const shown = useRef<string | null>(null)
  /** Where the caret was last inside the field, so a button inserts there. */
  const caret = useRef<Range | null>(null)

  // Rebuild the nodes only when the value changed from outside (load, sync, Cancel), so typing keeps its caret.
  useLayoutEffect(() => {
    const el = root.current
    if (!el || shown.current === value) return
    el.replaceChildren(...nodesOf(segmentsOf(value, variables)))
    shown.current = value
  }, [value, variables])

  function emit() {
    const next = serialize(root.current!)
    shown.current = next
    onChange(next)
  }

  function rememberCaret() {
    const selection = window.getSelection()
    if (selection?.rangeCount && root.current?.contains(selection.anchorNode)) caret.current = selection.getRangeAt(0).cloneRange()
  }

  /** Puts nodes where the caret was (else at the end) and the caret after them. */
  function insert(nodes: Node[]) {
    const el = root.current!
    const range = caret.current && el.contains(caret.current.startContainer) ? caret.current : null
    if (range) {
      range.deleteContents()
      for (const node of [...nodes].reverse()) range.insertNode(node)
    } else el.append(...nodes)
    const last = nodes.at(-1)
    if (last) {
      if (!last.nextSibling) el.append(document.createTextNode(CARET_SPOT))
      el.focus()
      placeCaretAfter(last)
    }
    rememberCaret()
    emit()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') return e.preventDefault() // one line
    if (e.key !== 'Backspace' && e.key !== 'Delete') return
    const target = pillBeside(root.current!, e.key === 'Delete')
    if (!target) return
    e.preventDefault()
    const before = target.previousSibling
    target.remove()
    if (before) placeCaretAfter(before)
    emit()
  }

  function onPaste(e: ClipboardEvent) {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain').replace(/[\r\n]+/g, ' ')
    insert(nodesOf(segmentsOf(text, variables)).filter(n => n.textContent !== CARET_SPOT))
  }

  return (
    <div className="vt">
      <span className={cx('k-input', 'vt-frame', invalid && 'k-input-invalid')}>
        <div
          ref={root}
          id={id}
          className="vt-input"
          role="textbox"
          tabIndex={0}
          aria-label={label}
          aria-multiline="false"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-placeholder={placeholder}
          contentEditable="true"
          suppressContentEditableWarning
          spellCheck
          onInput={emit}
          onKeyDown={onKeyDown}
          onKeyUp={rememberCaret}
          onMouseUp={rememberCaret}
          onBlur={rememberCaret}
          onPaste={onPaste}
        />
        {!value && placeholder && (
          <span className="vt-placeholder" aria-hidden="true">
            {segmentsOf(placeholder, variables).map(s =>
              'text' in s ? s.text : <span key={s.at} className="vt-pill">{s.variable.label}</span>,
            )}
          </span>
        )}
      </span>
      <div className="vt-add">
        {variables.map(v => (
          <Button
            key={v.key}
            size="sm"
            variant="ghost"
            // Keep the caret in the field while the button is pressed.
            onMouseDown={e => e.preventDefault()}
            onClick={() => insert([pill(v)])}
            title={`Insert the caller's ${v.label.toLowerCase()} at the cursor`}
          >
            <Icon name="plus" size={14} />
            {v.label}
          </Button>
        ))}
      </div>
    </div>
  )
}
