import { useEffect, useState, type KeyboardEvent } from 'react'

type Props = { label: string; value: string | null; placeholder: string; onSave: (value: string | null) => void; multiline?: boolean }

/** A fact that reads as plain text and edits in place: Enter or leaving saves, Esc reverts. */
export function EditableFact({ label, value, placeholder, onSave, multiline }: Props) {
  const [draft, setDraft] = useState(value ?? '')
  useEffect(() => setDraft(value ?? ''), [value])

  function commit() {
    const next = draft.trim() || null
    if (next !== (value ?? null)) onSave(next)
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !(multiline && e.shiftKey)) { e.preventDefault(); e.currentTarget.blur() }
    if (e.key === 'Escape') setDraft(value ?? '') // the app's key handler then blurs the field
  }
  const props = { className: 'fact-input', value: draft, placeholder, 'aria-label': label, onBlur: commit, onKeyDown, onChange: (e: { target: { value: string } }) => setDraft(e.target.value) }
  return (
    <>
      <dt>{label}</dt>
      <dd>{multiline ? <textarea rows={2} {...props} /> : <input autoComplete="off" {...props} />}</dd>
    </>
  )
}
