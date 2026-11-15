// The top of Settings > Assistant: the assistant's name, which opens the menu of the workspace's assistants
// (switch, New, Duplicate, Delete), and the numbers it answers. The name is changed under General.
import type { Assistant, PhoneNumber } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { formatNumber } from '../onboarding/flow.ts'
import { useRun } from '../store.tsx'
import { Dialog } from '../ui/form.tsx'
import { AppLink } from '../ui/AppLink.tsx'
import { Button, Icon } from '../ui/kit.tsx'
import './assistant.css'

type MenuProps = {
  assistant: Assistant
  assistants: Assistant[]
  canEdit: boolean
  onPick: (id: string) => void
  onNew: () => void
  onDuplicate: () => void
  onDelete: () => void
}

/** The name with a chevron: opens every assistant of the workspace, then New, Duplicate and Delete. */
function SwitchMenu({ assistant, assistants, canEdit, onPick, onNew, onDuplicate, onDelete }: MenuProps) {
  const t = useT()
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
      <button
        type="button"
        className="as-name as-switch"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('settings.assistantHeader.switchTip')}
        onClick={() => setOpen(o => !o)}
      >
        <span>{assistant.name}</span>
        <Icon name="down" size={16} className="as-name-chevron" />
      </button>
      {open && (
        <div className="as-menu" role="menu" aria-label={t('settings.assistantHeader.menu')}>
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
                <span className="lbl">{t('settings.assistantHeader.new')}</span>
              </button>
              <button type="button" role="menuitem" className="nav-item" onClick={choose(onDuplicate)}>
                <Icon name="copy" size={15} />
                <span className="lbl">{t('settings.assistantHeader.duplicate', { name: assistant.name })}</span>
              </button>
              {assistants.length > 1 && (
                <button type="button" role="menuitem" className="nav-item as-menu-danger" onClick={choose(onDelete)}>
                  <Icon name="trash" size={15} />
                  <span className="lbl">{t('settings.assistantHeader.deleteMenu', { name: assistant.name })}</span>
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Which numbers this assistant answers. Each opens its settings (Workspace settings, Phone numbers), the one place that picks
 * the assistant answering a number: a number has exactly one, so it is chosen there, not taken from another here.
 */
function NumberChips({
  assistant,
  isDefault,
  numbers,
  canEdit,
}: {
  assistant: Assistant
  isDefault: boolean
  numbers: PhoneNumber[]
  canEdit: boolean
}) {
  const t = useT()
  const mine = numbers.filter(n => n.assistant_id === assistant.id || (!n.assistant_id && isDefault))
  return (
    <div className="as-numbers">
      {mine.map(n => (
        <a
          key={n.id}
          className="as-chip"
          href={`#workspace/phone/${n.id}`}
          title={t('settings.assistantHeader.numberTip')}
        >
          {formatNumber(n.e164)}
        </a>
      ))}
      {!mine.length &&
        (canEdit ? (
          <a className="help" href="#workspace/phone" title={t('settings.assistantHeader.noNumberTip')}>
            {t('settings.assistantHeader.noNumberChoose')}
          </a>
        ) : (
          <span className="help">{t('settings.assistantHeader.noNumber')}</span>
        ))}
    </div>
  )
}

type Props = {
  assistant: Assistant
  assistants: Assistant[]
  numbers: PhoneNumber[]
  canEdit: boolean
  onPick: (id: string) => void
  toast: (text: string) => void
}

export function AssistantHeader({ assistant, assistants, numbers, canEdit, onPick, toast }: Props) {
  const t = useT()
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
    toast(t('settings.assistantHeader.added', { name: added.name }))
  }, [assistants, awaiting, onPick, toast, t])
  const known = () => new Set(assistants.map(a => a.id))
  const isDefault = assistants[0]?.id === assistant.id
  const fallback = assistants.find(a => a.id !== assistant.id)

  return (
    <div className="as-head">
      <div className="as-title">
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
          <span className="help">
            <AppLink to="#workspace/phone">{t('settings.assistantHeader.noPhoneNumber')}</AppLink>
          </span>
        </div>
      ) : (
        <NumberChips assistant={assistant} isDefault={isDefault} numbers={numbers} canEdit={canEdit} />
      )}
      {deleting && fallback && (
        <Dialog
          title={t('settings.assistantHeader.deleteTitle', { name: assistant.name })}
          description={t('settings.assistantHeader.deleteDescription', {
            name: (isDefault ? fallback : assistants[0]!).name,
          })}
          size="sm"
          onClose={() => setDeleting(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(false)}>
                {t('common.action.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setDeleting(false)
                  onPick(fallback.id)
                  void run('assistant.delete', { assistantId: assistant.id })
                  toast(t('settings.assistantHeader.deleted', { name: assistant.name }))
                }}
              >
                {t('common.action.delete')}
              </Button>
            </>
          }
        />
      )}
    </div>
  )
}
