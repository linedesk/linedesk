// "New workspace": the one dialog for it, from the workspace menu and from Server admin › Workspaces (decision Q8).
// Only server admins create workspaces (`mayCreateWorkspace`, the rule from NoWorkspace); the server checks again.
// Owner "Me": the admin becomes its owner, it becomes the session's active workspace and opens (its onboarding
// starts); POST /v1/workspaces runs workspace.create without an owner. Owner by email: workspace.create with that
// owner, who becomes it at once (an existing confirmed account) or after confirming the emailed invitation; the admin
// does not join it and stays where they are. Refused because the session's passkey check ran out meanwhile (403
// `admin_second_factor`): the dialog offers the passkey prompt (Server admin opens on it) instead of an error line.
// Country: required, prefilled from the country hint (countryHint.ts). Saved as the workspace's country only when
// picked; left as prefilled it stays Automatic on that hint, so a number connected later still decides it. For another
// owner the prefill is this browser's own hint (time zone, language), never the admin's sign-up location.
import type { WorkspaceCreateData } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { useMemo, useState } from 'react'
import { runAdmin } from '../admin/api.ts'
import { type AdminSecondFactor, createWorkspace } from '../auth.ts'
import { secondFactorDue } from '../CreateWorkspace.tsx'
import { type CreatingPhase, CreatingStatus } from '../CreatingStatus.tsx'
import { localCountryHint, useCountryHint } from '../countryHint.ts'
import { CountrySelect } from '../settings/CountrySelect.tsx'
import { emailError } from '../sign-in-code.ts'
import { Select } from '../ui/controls.tsx'
import { Dialog, FormField, FormMessage, Input } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'

/** Server admin opens on the passkey check while it is due (Workspace.tsx, AdminMode). */
const openPasskeyCheck = () => {
  window.location.hash = '#admin'
}

export type Owner = 'me' | 'other'
type Form = { name: string; country: string; owner: Owner; ownerEmail: string; ownerName: string }
type Errors = { name?: string; country?: string; ownerEmail?: string; form?: string }

/** What `workspace.create` is sent for an owner by email: the address, and the name only when one was given. */
export function ownerInput(form: Pick<Form, 'ownerEmail' | 'ownerName'>): { email: string; name?: string } {
  const name = form.ownerName.trim()
  return { email: form.ownerEmail.trim(), ...(name ? { name } : {}) }
}

/** The field that is wrong first, in the order the form shows them; none when the form can be sent. */
export function formErrors(
  form: Form,
  t: ReturnType<typeof useT>,
  checkEmail: (email: string) => string | null = emailError,
): Errors {
  const errors: Errors = {}
  if (!form.name.trim()) errors.name = t('shell.newWorkspace.nameMissing')
  if (!form.country) errors.country = t('shell.newWorkspace.countryMissing')
  if (form.owner === 'other') {
    const email = checkEmail(form.ownerEmail)
    if (email) errors.ownerEmail = email
  }
  return errors
}

type Props = {
  onClose: () => void
  /** The page the app opens on in the new workspace when it is the admin's own (its onboarding when left out). */
  returnTo?: string
  /**
   * Offer an owner by email. Off by default where `returnTo` is given (the setup page): its New workspace continues
   * the setup in the new workspace, so it is always the admin's own.
   */
  ownerChoice?: boolean
  /**
   * After a workspace was made for someone else: Server admin reloads its list, closes the dialog and says so in a
   * toast. Without it the dialog says so itself.
   */
  onCreatedForOwner?: (text: string) => void | Promise<void>
}

export function NewWorkspaceDialog({ onClose, returnTo = '', ownerChoice = !returnTo, onCreatedForOwner }: Props) {
  const t = useT()
  const signUpHint = useCountryHint()
  const browserHint = useMemo(localCountryHint, [])
  const [form, setForm] = useState<Omit<Form, 'country'>>({ name: '', owner: 'me', ownerEmail: '', ownerName: '' })
  // The hint until the admin picks one.
  const [pickedCountry, setPickedCountry] = useState<string | null>(null)
  const [errors, setErrors] = useState<Errors>({})
  const [phase, setPhase] = useState<CreatingPhase>('idle')
  const [passkeyFirst, setPasskeyFirst] = useState<AdminSecondFactor | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const busy = phase !== 'idle'
  const forOther = ownerChoice && form.owner === 'other'
  const hint = forOther ? browserHint : signUpHint
  const country = pickedCountry ?? hint?.country ?? ''

  const set = (patch: Partial<Omit<Form, 'country'>>) => {
    setForm(f => ({ ...f, ...patch }))
    setErrors({})
  }

  function createdText({ workspace, owner }: WorkspaceCreateData) {
    return owner.joined === 'added'
      ? t('shell.newWorkspace.created.added', { name: workspace.name, email: owner.email })
      : t('shell.newWorkspace.created.invited', { name: workspace.name, email: owner.email })
  }

  async function create() {
    if (busy) return
    const found = formErrors({ ...form, country, owner: forOther ? 'other' : 'me' }, t)
    if (found.name || found.country || found.ownerEmail) {
      setErrors(found)
      document
        .getElementById(found.name ? 'new-ws-name' : found.country ? 'new-ws-country' : 'new-ws-owner-email')
        ?.focus()
      return
    }
    setPhase('creating')
    setErrors({})
    try {
      if (forOther) {
        const data = (await runAdmin('workspace.create', {
          name: form.name.trim(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          ...(pickedCountry ? { country: pickedCountry } : {}),
          ...(hint ? { countryHint: hint } : {}),
          owner: ownerInput(form),
        })) as unknown as WorkspaceCreateData
        const text = createdText(data)
        if (onCreatedForOwner) {
          await onCreatedForOwner(text)
          onClose()
        } else {
          setPhase('idle')
          setCreated(text)
        }
        return
      }
      // The new workspace is the session's active one now; reloading opens it with its own local store.
      await createWorkspace(form.name.trim(), pickedCountry)
      // The page stays on screen until the reload has loaded the app again: say so meanwhile.
      setPhase('opening')
      window.location.hash = returnTo
      window.location.reload()
    } catch (e) {
      const due = await secondFactorDue()
      setPhase('idle')
      if (due) setPasskeyFirst(due)
      else setErrors({ form: e instanceof Error ? e.message : String(e) })
    }
  }

  if (created)
    return (
      <Dialog
        title={t('shell.newWorkspace.title')}
        size="sm"
        onClose={onClose}
        onSubmit={e => {
          e.preventDefault()
          onClose()
        }}
        footer={
          <Button type="submit" variant="primary" shortcut={['⏎']}>
            {t('shell.newWorkspace.done')}
          </Button>
        }
      >
        <Note tone="info" role="status">
          {created}
        </Note>
      </Dialog>
    )

  return (
    <Dialog
      title={t('shell.newWorkspace.title')}
      description={forOther ? t('shell.newWorkspace.descriptionForOwner') : t('shell.newWorkspace.description')}
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={e => {
        e.preventDefault()
        if (passkeyFirst) openPasskeyCheck()
        else void create()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          {passkeyFirst ? (
            <Button type="submit" variant="primary" shortcut={['⏎']} title={t('shell.newWorkspace.passkey.openCheck')}>
              {/* i18n-dynamic: shell.newWorkspace.passkey.button.* */}
              {t(`shell.newWorkspace.passkey.button.${passkeyFirst}`)}
            </Button>
          ) : (
            <Button type="submit" variant="primary" busy={busy} shortcut={['⏎']}>
              {phase === 'opening'
                ? t('shell.newWorkspace.opening')
                : busy
                  ? t('shell.newWorkspace.creating')
                  : t('shell.newWorkspace.create')}
            </Button>
          )}
        </>
      }
    >
      {passkeyFirst && (
        <Note tone="info">
          {/* i18n-dynamic: shell.newWorkspace.passkey.note.* */}
          {t(`shell.newWorkspace.passkey.note.${passkeyFirst}`)}
        </Note>
      )}
      <FormField id="new-ws-name" label={t('shell.newWorkspace.name')} error={errors.name}>
        <Input
          id="new-ws-name"
          value={form.name}
          invalid={!!errors.name}
          maxLength={80}
          autoComplete={forOther ? 'off' : 'organization'}
          disabled={busy}
          // A business someone else owns: Server admin's example name (the same in English).
          placeholder={forOther ? t('admin.example.business') : t('shell.newWorkspace.namePlaceholder')}
          onChange={e => set({ name: e.target.value })}
        />
      </FormField>
      <FormField
        id="new-ws-country"
        label={t('settings.general.country.label')}
        description={t('shell.newWorkspace.countryHelp')}
        error={errors.country}
      >
        <CountrySelect
          id="new-ws-country"
          value={country}
          disabled={busy}
          onChange={c => {
            setPickedCountry(c)
            setErrors({})
          }}
        />
      </FormField>
      {ownerChoice && (
        <FormField id="new-ws-owner" label={t('shell.newWorkspace.owner')}>
          <Select<Owner>
            id="new-ws-owner"
            label={t('shell.newWorkspace.owner')}
            value={form.owner}
            disabled={busy}
            options={[
              {
                value: 'me',
                label: t('shell.newWorkspace.owner.me'),
                description: t('shell.newWorkspace.owner.meHelp'),
              },
              {
                value: 'other',
                label: t('shell.newWorkspace.owner.other'),
                description: t('shell.newWorkspace.owner.otherHelp'),
              },
            ]}
            onChange={owner => set({ owner })}
          />
        </FormField>
      )}
      {forOther && (
        <>
          <FormField
            id="new-ws-owner-email"
            label={t('shell.newWorkspace.ownerEmail')}
            help={t('shell.newWorkspace.ownerEmailHelp')}
            error={errors.ownerEmail}
          >
            <Input
              id="new-ws-owner-email"
              type="email"
              placeholder={t('admin.example.ownerEmail')}
              autoComplete="off"
              disabled={busy}
              invalid={!!errors.ownerEmail}
              value={form.ownerEmail}
              onChange={e => set({ ownerEmail: e.target.value })}
            />
          </FormField>
          <FormField
            id="new-ws-owner-name"
            label={t('shell.newWorkspace.ownerName')}
            help={t('shell.newWorkspace.ownerNameHelp')}
          >
            <Input
              id="new-ws-owner-name"
              maxLength={80}
              autoComplete="off"
              disabled={busy}
              value={form.ownerName}
              onChange={e => set({ ownerName: e.target.value })}
            />
          </FormField>
        </>
      )}
      {errors.form && <FormMessage>{errors.form}</FormMessage>}
      {!forOther && <CreatingStatus phase={phase} name={form.name.trim()} />}
    </Dialog>
  )
}
