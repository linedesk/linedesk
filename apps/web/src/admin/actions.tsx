// What an admin can do to a user or a workspace, in one place: the detail page shows the actions as
// a row of buttons, the list as quick icon buttons on each row (and a ⋯ menu on touch screens).
// Actions that change access ask once in a dialog; the rest run at once.
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { confirmText, startImpersonation } from '../impersonation.ts'
import { Dialog, FormMessage, Input } from '../ui/form.tsx'
import type { IconName } from '../ui/icons.ts'
import { Button, Icon } from '../ui/kit.tsx'
import { type AdminUser, type AdminWorkspace, runAdmin } from './api.ts'
import { errorText, type Notify } from './notify.ts'

type Confirmation = {
  text: string
  /** The confirming button. */
  action: string
  /** The heaviest actions: the button unlocks once this is typed. */
  typed?: string
  variant?: 'primary' | 'danger'
}

export type AdminAction = {
  id: string
  /** The button's words; a trailing … means it asks first. */
  label: string
  icon: IconName
  /** What it does, for the tooltip. */
  tip: string
  confirm?: Confirmation
  run: () => Promise<void>
  /** The toast afterwards. */
  done?: string
}

const userLabel = (u: AdminUser) => u.name || u.email

/** The actions that apply to this user: none of them on yourself except what is harmless. */
export function userActions(u: AdminUser, currentUserId: string, reload: () => Promise<void>): AdminAction[] {
  const name = userLabel(u)
  const isSelf = u.id === currentUserId
  const act = (action: 'user.disable' | 'user.enable' | 'instanceAdmin.grant' | 'instanceAdmin.revoke') => async () => {
    await runAdmin(action, { userId: u.id })
    await reload()
  }
  const actions: AdminAction[] = []
  if (!isSelf && !u.instance_admin && !u.disabled_at)
    actions.push({
      id: 'impersonate',
      label: `Sign in as ${name}…`,
      icon: 'user',
      tip: 'See Linedesk exactly as they do, for up to an hour. Recorded as done by you.',
      confirm: { text: confirmText(name), action: `Sign in as ${name}`, variant: 'primary' },
      // Reloads into the app as this user; throws with the reason when refused.
      run: () => startImpersonation(u.id),
    })
  if (!u.instance_admin && !u.disabled_at)
    actions.push({
      id: 'grant',
      label: 'Make admin…',
      icon: 'shield',
      tip: 'Sees every workspace and user, and sets the provider keys.',
      confirm: {
        text: `${name} will see every workspace and user, and can change the provider keys.`,
        action: 'Make instance admin',
        variant: 'primary',
      },
      run: act('instanceAdmin.grant'),
      done: `${name} is an instance admin.`,
    })
  if (u.instance_admin && !isSelf && !u.instance_admin_by_env)
    actions.push({
      id: 'revoke',
      label: 'Remove admin…',
      icon: 'shield',
      tip: 'They keep their workspaces and lose access to Admin.',
      confirm: { text: `${name} loses access to Admin.`, action: 'Remove instance admin' },
      run: act('instanceAdmin.revoke'),
      done: `${name} is no longer an instance admin.`,
    })
  if (u.disabled_at)
    actions.push({
      id: 'enable',
      label: 'Enable',
      icon: 'restart',
      tip: 'They can sign in again.',
      run: act('user.enable'),
      done: `${name} can sign in again.`,
    })
  else if (!isSelf)
    actions.push({
      id: 'disable',
      label: 'Disable…',
      icon: 'ban',
      tip: 'Signs them out everywhere; they cannot sign in until enabled.',
      confirm: {
        text: `${name} is signed out everywhere and cannot sign in again until enabled.`,
        action: 'Disable user',
      },
      run: act('user.disable'),
      done: `${name} is disabled and signed out.`,
    })
  return actions
}

export function workspaceActions(w: AdminWorkspace, reload: () => Promise<void>): AdminAction[] {
  const set = (disabled: boolean) => async () => {
    await runAdmin(disabled ? 'workspace.disable' : 'workspace.enable', { workspaceId: w.id })
    await reload()
  }
  return w.disabled_at
    ? [
        {
          id: 'enable',
          label: 'Enable',
          icon: 'restart',
          tip: 'Calls to its numbers are answered again.',
          run: set(false),
          done: `${w.name} is enabled. Its calls are answered again.`,
        },
      ]
    : [
        {
          id: 'disable',
          label: 'Disable…',
          icon: 'ban',
          tip: 'Its numbers stop being answered; members can still sign in and read.',
          confirm: {
            text: `Calls to ${w.name} will no longer be answered and its members can only read.`,
            action: 'Disable workspace',
            typed: w.name,
          },
          run: set(true),
          done: `${w.name} is disabled. Its calls are no longer answered.`,
        },
      ]
}

function ConfirmDialog({ action, onClose, notify }: { action: AdminAction; onClose: () => void; notify: Notify }) {
  const confirm = action.confirm!
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const unlocked = !confirm.typed || typed.trim().toLowerCase() === confirm.typed.trim().toLowerCase()
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!unlocked || busy) return
    setBusy(true)
    setError(null)
    try {
      await action.run()
      onClose()
      if (action.done) notify(action.done)
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={confirm.action}
      description={confirm.text}
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant={confirm.variant ?? 'danger'} disabled={!unlocked || busy}>
            {busy ? 'Working…' : confirm.action}
          </Button>
        </>
      }
    >
      {confirm.typed && (
        <Input
          value={typed}
          placeholder={confirm.typed}
          aria-label={`Type ${confirm.typed} to confirm`}
          autoComplete="off"
          onChange={e => setTyped(e.target.value)}
        />
      )}
      {error && <FormMessage>{error}</FormMessage>}
    </Dialog>
  )
}

/** Runs a picked action: at once, or after its confirmation dialog. Render `dialog` somewhere. */
export function useActionRunner(notify: Notify) {
  const [pending, setPending] = useState<AdminAction | null>(null)
  async function pick(action: AdminAction) {
    if (action.confirm) return setPending(action)
    try {
      await action.run()
      if (action.done) notify(action.done)
    } catch (err) {
      notify(errorText(err))
    }
  }
  const dialog = pending && <ConfirmDialog action={pending} notify={notify} onClose={() => setPending(null)} />
  return { pick: (action: AdminAction) => void pick(action), dialog }
}

/** The detail page's actions: a row of buttons under the title. */
export function ActionBar({ actions, onPick }: { actions: AdminAction[]; onPick: (action: AdminAction) => void }) {
  if (!actions.length) return null
  return (
    <div className="adm-actbar">
      {actions.map(a => (
        <Button key={a.id} size="sm" icon={a.icon} title={a.tip} onClick={() => onPick(a)}>
          {a.label}
        </Button>
      ))}
    </div>
  )
}

/** A row's quick actions: icon buttons on hover or focus, a ⋯ menu on touch screens. */
export function RowActions({ actions, onPick }: { actions: AdminAction[]; onPick: (action: AdminAction) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  if (!actions.length) return null
  const choose = (a: AdminAction) => {
    setOpen(false)
    onPick(a)
  }
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !open) return
    e.stopPropagation()
    setOpen(false)
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps the row's click (open) away from its buttons; Esc closes the menu
    <div className="adm-rowacts" ref={root} onClick={e => e.stopPropagation()} onKeyDown={onKeyDown}>
      <span className="adm-rowacts-icons">
        {actions.map(a => (
          <Button
            key={a.id}
            size="sm"
            variant="ghost"
            icon={a.icon}
            aria-label={a.label.replace('…', '')}
            title={a.label.replace('…', '')}
            data-desc={a.tip}
            onClick={() => choose(a)}
          />
        ))}
      </span>
      <span className="adm-rowacts-more">
        <Button
          size="sm"
          variant="ghost"
          icon="more"
          aria-label="Actions"
          aria-haspopup="menu"
          aria-expanded={open}
          title="Actions"
          onClick={() => setOpen(o => !o)}
        />
        {open && (
          <div className="adm-rowmenu" role="menu">
            {actions.map(a => (
              <button key={a.id} type="button" role="menuitem" className="nav-item" onClick={() => choose(a)}>
                <Icon name={a.icon} size={15} />
                <span className="lbl">{a.label}</span>
              </button>
            ))}
          </div>
        )}
      </span>
    </div>
  )
}
