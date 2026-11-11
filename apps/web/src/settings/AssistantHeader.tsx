// The top of Settings > Assistant: the assistant's name, renamed in place, with a switcher to the
// workspace's other assistants (New, Duplicate, Delete), and the numbers it answers.
import type { Assistant, PhoneNumber } from '@linedesk/db/types'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { formatNumber } from '../onboarding/flow.ts'
import { useRun } from '../store.tsx'
import { Dialog } from '../ui/form.tsx'
import { Button, cx, Icon } from '../ui/kit.tsx'
import './assistant.css'

const NAME_MAX = 60

/** The name as a title: click or Enter edits it, Enter or leaving saves, Esc cancels. */
function InlineName({
  assistant,
  canEdit,
  onRenamed,
}: {
  assistant: Assistant
  canEdit: boolean
  onRenamed: (from: string) => void
}) {
  const run = useRun()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(assistant.name)
  const [problem, setProblem] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const cancelled = useRef(false)
  useEffect(() => {
    if (!editing) setValue(assistant.name)
  }, [assistant.name, editing])
  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  function save() {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const name = value.trim()
    if (!name) return setProblem('Enter a name. Callers hear it.')
    if (name.length > NAME_MAX) return setProblem(`At most ${NAME_MAX} characters.`)
    setEditing(false)
    setProblem(null)
    if (name === assistant.name) return
    void run('assistant.update', { assistantId: assistant.id, name })
    onRenamed(assistant.name)
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    // The name has the keyboard while it is edited: no page shortcut reacts.
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      save()
    } else if (e.key === 'Escape') {
      cancelled.current = true
      setValue(assistant.name)
      setProblem(null)
      setEditing(false)
    }
  }

  if (editing)
    return (
      <span className="as-name-edit">
        <input
          ref={input}
          className={cx('as-name-input', problem && 'is-invalid')}
          value={value}
          maxLength={NAME_MAX + 10}
          aria-label="Assistant name"
          aria-invalid={!!problem}
          onChange={e => {
            setValue(e.target.value)
            setProblem(null)
          }}
          onBlur={save}
          onKeyDown={onKey}
        />
        {problem && (
          <span className="k-field-msg" role="alert">
            {problem}
          </span>
        )}
      </span>
    )
  return (
    <button
      type="button"
      className="as-name"
      disabled={!canEdit}
      title={canEdit ? 'Rename (⏎)' : undefined}
      onClick={() => setEditing(true)}
    >
      <span>{assistant.name}</span>
      {canEdit && <Icon name="pencil" size={14} className="as-name-pen" />}
    </button>
  )
}

type MenuProps = {
  assistant: Assistant
  assistants: Assistant[]
  canEdit: boolean
  onPick: (id: string) => void
  onNew: () => void
  onDuplicate: () => void
  onDelete: () => void
}

/** The chevron next to the name: every assistant of the workspace, then New, Duplicate and Delete. */
function SwitchMenu({ assistant, assistants, canEdit, onPick, onNew, onDuplicate, onDelete }: MenuProps) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const items = () => [
    ...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? []),
  ]
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  function onKey(e: KeyboardEvent) {
    if (!open) return
    e.stopPropagation()
    const all = items()
    const at = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false)
      root.current?.querySelector<HTMLElement>('.as-switch')?.focus()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      all[(at + 1) % all.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      all[(at - 1 + all.length) % all.length]?.focus()
    }
  }
  const choose = (then: () => void) => () => {
    setOpen(false)
    then()
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys and Esc move through and close the menu
    <div className="as-switch-wrap" ref={root} onKeyDown={onKey}>
      <Button
        size="sm"
        variant="ghost"
        icon="down"
        className="as-switch"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Switch assistant"
        title="Switch assistant"
        onClick={() => setOpen(o => !o)}
      />
      {open && (
        <div className="as-menu" role="menu" aria-label="Assistants">
          {assistants.map(a => (
            <button
              key={a.id}
              type="button"
              role="menuitemradio"
              aria-checked={a.id === assistant.id}
              className="nav-item"
              onClick={choose(() => onPick(a.id))}
            >
              <span className="lbl">{a.name}</span>
              {a.id === assistant.id && <Icon name="check" size={14} />}
            </button>
          ))}
          {canEdit && (
            <>
              <hr className="k-sep" />
              <button type="button" role="menuitem" className="nav-item" onClick={choose(onNew)}>
                <Icon name="plus" size={15} />
                <span className="lbl">New assistant</span>
              </button>
              <button type="button" role="menuitem" className="nav-item" onClick={choose(onDuplicate)}>
                <Icon name="copy" size={15} />
                <span className="lbl">Duplicate {assistant.name}</span>
              </button>
              {assistants.length > 1 && (
                <button type="button" role="menuitem" className="nav-item as-menu-danger" onClick={choose(onDelete)}>
                  <Icon name="trash" size={15} />
                  <span className="lbl">Delete {assistant.name}…</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Which numbers this assistant answers, and (with several numbers) a list to give it more. */
function NumberChips({
  assistant,
  isDefault,
  numbers,
  assistants,
  canEdit,
}: {
  assistant: Assistant
  isDefault: boolean
  numbers: PhoneNumber[]
  assistants: Assistant[]
  canEdit: boolean
}) {
  const run = useRun()
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus()
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const answers = (n: PhoneNumber) => n.assistant_id === assistant.id || (!n.assistant_id && isDefault)
  const owner = (n: PhoneNumber) => assistants.find(a => a.id === n.assistant_id)?.name ?? assistants[0]?.name
  const mine = numbers.filter(answers)
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Esc closes the number list
    <div
      className="as-numbers"
      ref={root}
      onKeyDown={e => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          setOpen(false)
        }
      }}
    >
      {mine.length ? (
        mine.map(n => (
          <span key={n.id} className="as-chip">
            {formatNumber(n.e164)}
          </span>
        ))
      ) : (
        <span className="help">Answers no number yet</span>
      )}
      {canEdit && numbers.length > 1 && (
        <span className="as-assign">
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            aria-expanded={open}
            aria-haspopup="menu"
            title="Choose the numbers this assistant answers"
            onClick={() => setOpen(o => !o)}
          >
            Numbers
          </Button>
          {open && (
            <div className="as-menu" role="menu" aria-label="Numbers">
              {numbers.map(n => (
                <button
                  key={n.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={answers(n)}
                  className="nav-item"
                  disabled={answers(n)}
                  title={
                    answers(n)
                      ? `${assistant.name} answers it`
                      : `Answered by ${owner(n)} now. Move it to ${assistant.name}.`
                  }
                  onClick={() => {
                    setOpen(false)
                    void run('phoneNumber.update', { phoneNumberId: n.id, assistantId: assistant.id })
                  }}
                >
                  <span className="lbl">{formatNumber(n.e164)}</span>
                  {answers(n) ? <Icon name="check" size={14} /> : <span className="help">{owner(n)}</span>}
                </button>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  )
}

type Props = {
  assistant: Assistant
  assistants: Assistant[]
  numbers: PhoneNumber[]
  canEdit: boolean
  onPick: (id: string) => void
  /** The name was changed; `from` is the old one (the greeting may still say it). */
  onRenamed: (from: string) => void
  toast: (text: string) => void
}

export function AssistantHeader({ assistant, assistants, numbers, canEdit, onPick, onRenamed, toast }: Props) {
  const run = useRun()
  const [deleting, setDeleting] = useState(false)
  // A new or copied assistant arrives by sync: open it as soon as it is there.
  const [awaiting, setAwaiting] = useState<Set<string> | null>(null)
  useEffect(() => {
    if (!awaiting) return
    const added = assistants.find(a => !awaiting.has(a.id))
    if (!added) return
    setAwaiting(null)
    onPick(added.id)
    toast(`${added.name} added.`)
  }, [assistants, awaiting, onPick, toast])
  const known = () => new Set(assistants.map(a => a.id))
  const isDefault = assistants[0]?.id === assistant.id
  const fallback = assistants.find(a => a.id !== assistant.id)

  return (
    <div className="as-head">
      <div className="as-title">
        <InlineName key={assistant.id} assistant={assistant} canEdit={canEdit} onRenamed={onRenamed} />
        <SwitchMenu
          assistant={assistant}
          assistants={assistants}
          canEdit={canEdit}
          onPick={onPick}
          onNew={() => {
            setAwaiting(known())
            void run('assistant.create', {})
          }}
          onDuplicate={() => {
            setAwaiting(known())
            void run('assistant.create', { copyOf: assistant.id })
          }}
          onDelete={() => setDeleting(true)}
        />
      </div>
      {numbers.length === 0 ? (
        <div className="as-numbers">
          <a className="help" href="#settings/phone">
            No phone number yet
          </a>
        </div>
      ) : (
        <NumberChips
          assistant={assistant}
          isDefault={isDefault}
          numbers={numbers}
          assistants={assistants}
          canEdit={canEdit}
        />
      )}
      {deleting && fallback && (
        <Dialog
          title={`Delete ${assistant.name}?`}
          description={`Its numbers are answered by ${(isDefault ? fallback : assistants[0]!).name} from then on.`}
          size="sm"
          onClose={() => setDeleting(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(false)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setDeleting(false)
                  onPick(fallback.id)
                  void run('assistant.delete', { assistantId: assistant.id })
                  toast(`${assistant.name} deleted.`)
                }}
              >
                Delete
              </Button>
            </>
          }
        />
      )}
    </div>
  )
}
