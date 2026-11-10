import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

type Props = { label: string; value: string | null; placeholder: string; onSave: (value: string | null) => void; multiline?: boolean }

/** A fact that reads as plain text and edits in place: Enter or leaving saves, Esc reverts. */
export function EditableFact({ label, value, placeholder, onSave, multiline }: Props) {
  const [draft, setDraft] = useState(value ?? '')
  /** The value when editing started; null while the field is not focused. */
  const editingFrom = useRef<string | null>(null)
  useEffect(() => { if (editingFrom.current === null) setDraft(value ?? '') }, [value]) // never overwrite a field someone is typing in

  function commit() {
    const untouched = draft === editingFrom.current
    editingFrom.current = null
    if (untouched) return setDraft(value ?? '') // nothing typed: show what sync brought meanwhile
    const next = draft.trim() || null
    if (next !== (value ?? null)) onSave(next)
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !(multiline && e.shiftKey)) { e.preventDefault(); e.currentTarget.blur() }
    if (e.key === 'Escape') setDraft(editingFrom.current ?? value ?? '') // the app's key handler then blurs the field
  }
  const props = {
    className: 'fact-input', value: draft, placeholder, 'aria-label': label, onBlur: commit, onKeyDown,
    onFocus: () => { editingFrom.current = draft },
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
  }
  return (
    <>
      <dt>{label}</dt>
      <dd>{multiline ? <textarea rows={2} {...props} /> : <input autoComplete="off" {...props} />}</dd>
    </>
  )
}
