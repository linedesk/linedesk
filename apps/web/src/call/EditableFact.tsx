import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

type Edit = { value: string | null; onSave: (value: string | null) => void; multiline?: boolean }

/**
 * A field that saves itself: Enter or leaving saves, Esc reverts. Returns the props for the input or
 * textarea. A value that changes by sync never overwrites what someone is typing.
 */
export function useInlineEdit({ value, onSave, multiline }: Edit) {
  const [draft, setDraft] = useState(value ?? '')
  /** The value when editing started; null while the field is not focused. */
  const editingFrom = useRef<string | null>(null)
  useEffect(() => {
    if (editingFrom.current === null) setDraft(value ?? '')
  }, [value])

  function commit() {
    const untouched = draft === editingFrom.current
    editingFrom.current = null
    if (untouched) return setDraft(value ?? '') // nothing typed: show what sync brought meanwhile
    const next = draft.trim() || null
    if (next !== (value ?? null)) onSave(next)
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !(multiline && e.shiftKey)) {
      e.preventDefault()
      e.currentTarget.blur()
    }
    if (e.key === 'Escape') setDraft(editingFrom.current ?? value ?? '') // the app's key handler then blurs the field
  }
  return {
    value: draft,
    onBlur: commit,
    onKeyDown,
    onFocus: () => {
      editingFrom.current = draft
    },
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
  }
}

type Props = Edit & { label: string; placeholder: string }

/** A fact that reads as plain text and edits in place (the call view's contact panel). */
export function EditableFact({ label, value, placeholder, onSave, multiline }: Props) {
  const edit = useInlineEdit({ value, onSave, multiline })
  const props = { className: 'fact-input', placeholder, 'aria-label': label, ...edit }
  return (
    <>
      <dt>{label}</dt>
      <dd>{multiline ? <textarea rows={2} {...props} /> : <input autoComplete="off" {...props} />}</dd>
    </>
  )
}
