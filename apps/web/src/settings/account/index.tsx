// Account: profile, notifications, sign-in and sessions of the signed-in member, one section at a time
// (#account/<section>). Profile, sign-in and sessions are Better Auth's own data (see account-api.ts), so they do
// not go through the outbox; notifications are per workspace (settings/Notifications.tsx).
import type { MessageKey } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { auth, fetchMe, passkeySupported } from '../../auth.ts'
import { removeAuthenticator } from '../../authenticator-api.ts'
import { ConfirmEmail } from '../../ConfirmEmail.tsx'
import { refreshQuery, useQuery } from '../../cachedQuery.ts'
import { signInAgain } from '../../localData.ts'
import { CODE_LENGTH, normalizeCode, RESEND_AFTER_S } from '../../sign-in-code.ts'
import { useLegalLinks } from '../../shell/WorkspaceMenu.tsx'
import { useImpersonating } from '../../supportAccess.ts'
import { refreshTeam } from '../../team/team-api.ts'
import { changedByLabel } from '../../team/team-model.ts'
import { dateTimeLabel } from '../../time.ts'
import { Input, onSaveKey, SaveBar } from '../../ui/form.tsx'
import { Badge, Button, Note } from '../../ui/kit.tsx'
import { HelpTip } from '../../ui/HelpTip.tsx'
import { Loading, Skeleton, SkeletonText } from '../../ui/LoadStates.tsx'
import { type PageSection, SettingsLayout, useSection } from '../../ui/SettingsLayout.tsx'
import { Field, Section, TextInput } from '../fields.tsx'
import { AvatarField } from './AvatarField.tsx'
import {
  ACCOUNT,
  type Account,
  ConfirmWithPasskey,
  changeEmail,
  changeName,
  changePassword,
  confirmWithPasskey,
  loadAccount,
  loadPasskeys,
  loadSessions,
  PASSKEYS,
  removePasskey,
  requestEmailChange,
  SESSIONS,
  SignInAgain,
  setFirstPassword,
  signOutOtherSessions,
  signOutSession,
} from './account-api.ts'
import { hasPassword, orderSessions, passwordProblem, SESSIONS_SHOWN, type SessionRow } from './account-model.ts'
import { useAddPasskey } from './add-passkey.ts'
import { AUTHENTICATOR_HOURS, AuthenticatorQr, useAuthenticatorSetup } from './authenticator.tsx'
import { PersonalKeys } from './PersonalKeys.tsx'
import { Preferences } from './Preferences.tsx'

type SectionProps = { account: Account; reload: () => Promise<void> }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Runs one request at a time and keeps its outcome (an error, or what was done) for the form to show. */
function useRequest() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  // The request the server refused until a passkey sign-in: confirmed in place, then run again.
  const [awaitingPasskey, setAwaitingPasskey] = useState<{ request: () => Promise<void>; doneText?: string } | null>(
    null,
  )
  // `retry` is what a passkey confirmation runs again: the request itself, or the one it confirms for.
  async function run(request: () => Promise<void>, doneText?: string, retry = request) {
    setBusy(true)
    setError(null)
    setDone(null)
    setAwaitingPasskey(null)
    try {
      await request()
      setDone(doneText ?? null)
    } catch (err) {
      setNeedsSignIn(err instanceof SignInAgain)
      if (err instanceof ConfirmWithPasskey) setAwaitingPasskey({ request: retry, doneText })
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }
  const confirmPasskey = awaitingPasskey
    ? () =>
        run(
          async () => {
            await confirmWithPasskey()
            await awaitingPasskey.request()
          },
          awaitingPasskey.doneText,
          awaitingPasskey.request,
        )
    : null
  const fail = (text: string | null) => {
    setDone(null)
    setError(text)
  }
  /** Forgets the outcome: the step-up note's Cancel. */
  const dismiss = () => {
    setError(null)
    setAwaitingPasskey(null)
  }
  return { busy, error, done, needsSignIn, confirmPasskey, setError: fail, dismiss, run }
}
type Request = ReturnType<typeof useRequest>

function SignInAgainButton() {
  const t = useT()
  return (
    <Button title={t('account.signInAgain.title')} onClick={() => void signInAgain()}>
      {t('account.signInAgain.button')}
    </Button>
  )
}

/**
 * The outcome of a form's last request, next to the form that caused it. A request that only waits for the passkey
 * (the server wants it, or its prompt was closed) is not a failure: a calm note with Cancel and Confirm, in place of
 * the form's own buttons (the form hides them while `confirmPasskey` is set).
 */
function FormStatus({
  request,
}: {
  request: Pick<Request, 'busy' | 'error' | 'done' | 'needsSignIn' | 'confirmPasskey' | 'dismiss'>
}) {
  const t = useT()
  if (request.error) {
    const { confirmPasskey } = request
    if (confirmPasskey)
      return (
        <Note
          tone="info"
          action={
            <>
              <Button
                size="sm"
                variant="ghost"
                title={t('account.confirmPasskey.cancelTitle')}
                onClick={request.dismiss}
              >
                {t('common.action.cancel')}
              </Button>
              <Button
                size="sm"
                variant="primary"
                title={t('account.confirmPasskey.title')}
                disabled={request.busy}
                onClick={() => void confirmPasskey()}
              >
                {request.busy ? t('account.passkeys.waiting') : t('account.confirmPasskey.button')}
              </Button>
            </>
          }
        >
          {request.error}
        </Note>
      )
    return (
      <Note tone="danger" action={request.needsSignIn && <SignInAgainButton />}>
        {request.error}
      </Note>
    )
  }
  return request.done ? (
    <span className="help" role="status">
      {request.done}
    </span>
  ) : null
}

/** A password field in the kit's input frame; its label is the surrounding Field. */
function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  autoFocus,
}: {
  id: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
  autoFocus?: boolean
}) {
  return (
    <span className="k-input">
      <input
        id={id}
        name={id}
        type="password"
        value={value}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        onChange={e => onChange(e.target.value)}
      />
    </span>
  )
}

function Profile({ account, reload, hasWorkspace }: SectionProps & { hasWorkspace: boolean }) {
  const t = useT()
  const [name, setName] = useState(account.user.name)
  const request = useRequest()
  const trimmed = name.trim()
  const dirty = trimmed !== account.user.name
  const save = (e: FormEvent) => {
    e.preventDefault()
    if (!trimmed || !dirty) return
    void request.run(async () => {
      await changeName(trimmed)
      await Promise.all([reload(), refreshTeam()]) // the Team list and call assignment show the new name
    }, t('account.profile.nameSaved'))
  }
  // `=== false`: an account remembered from before this field existed says nothing either way.
  const unconfirmed = account.user.emailVerified === false && account.methods.emailCode
  // The new address is proven with an email code, so it can only change where those are on.
  // On a white-label partner's own address the email is changed at the install's own (host-sessions.ts).
  const canChangeEmail = account.methods.emailCode && !account.methods.mainOrigin
  const [changingEmail, setChangingEmail] = useState(false)
  const [emailChanged, setEmailChanged] = useState<string | null>(null)
  return (
    <>
      {unconfirmed && (
        <ConfirmEmail
          email={account.user.email}
          onDone={reload}
          why={t('account.profile.confirmEmail', { email: account.user.email })}
        />
      )}
      <form className="ac-form" onSubmit={save} onKeyDown={e => onSaveKey(e, dirty && !!trimmed)}>
        <Section id="ac-profile" title={t('account.nav.profile.label')}>
          {/* The picture is shown to the people you work with; without a workspace there is nobody to show it to. */}
          {hasWorkspace && <AvatarField name={account.user.name} avatarUrl={account.avatarUrl ?? null} />}
          <Field id="ac-name" label={t('account.profile.name')} error={trimmed ? null : t('account.profile.enterName')}>
            <TextInput
              id="ac-name"
              value={name}
              onChange={setName}
              placeholder={t('account.profile.namePlaceholder')}
              invalid={!trimmed}
            />
          </Field>
          <Field
            label={t('account.profile.email')}
            tip={canChangeEmail ? t('account.profile.emailTipChange') : t('account.profile.emailTip')}
          >
            <div className="ac-inline">
              <span className="ac-value">{account.user.email}</span>
              {canChangeEmail && !changingEmail && (
                <Button
                  size="sm"
                  title={t('account.profile.changeEmailTitle')}
                  onClick={() => {
                    setEmailChanged(null)
                    setChangingEmail(true)
                  }}
                >
                  {t('account.profile.change')}
                </Button>
              )}
            </div>
            {emailChanged && (
              <span className="help" role="status">
                {emailChanged}
              </span>
            )}
          </Field>
          {/* Inside the name's form, so a group of its own: Enter and its buttons never save the name. */}
          {changingEmail && (
            <ChangeEmail
              current={account.user.email}
              onCancel={() => setChangingEmail(false)}
              onDone={async next => {
                await Promise.all([reload(), refreshTeam()]) // the Team list shows members' addresses
                setChangingEmail(false)
                setEmailChanged(t('account.profile.emailChanged', { email: next }))
              }}
            />
          )}
          <FormStatus request={request} />
          {account.profileChangedBy && <p className="help">{changedByLabel(account.profileChangedBy)}</p>}
        </Section>
        <SaveBar dirty={dirty} saving={request.busy} disabled={!trimmed} onCancel={() => setName(account.user.name)} />
      </form>
    </>
  )
}

const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

/**
 * Profile › Email › Change: the new address, then (unless this is a recent passkey sign-in) a code sent to
 * the current address to confirm it's you, then the code emailed to the new address, which moves the account
 * (apps/api/src/email-change.ts). Needs a recent sign-in, or a passkey sign-in once the account has a
 * passkey: the request offers "Sign in again" or "Confirm with passkey" then.
 */
function ChangeEmail({
  current,
  onCancel,
  onDone,
}: {
  current: string
  onCancel: () => void
  onDone: (next: string) => Promise<void>
}) {
  const t = useT()
  const [email, setEmail] = useState('')
  // The new address, and whose code is asked for: the current address's first, when the server wants it.
  const [target, setTarget] = useState<string | null>(null)
  const [step, setStep] = useState<'current' | 'new'>('new')
  const [code, setCode] = useState('')
  const [waitS, setWaitS] = useState(0)
  const request = useRequest()
  useEffect(() => {
    if (waitS <= 0) return
    const timer = setTimeout(() => setWaitS(s => s - 1), 1000)
    return () => clearTimeout(timer)
  }, [waitS])

  const next = email.trim().toLowerCase()
  const codeSent = (to: string, confirmCurrentEmail: boolean) => {
    setTarget(to)
    setStep(confirmCurrentEmail ? 'current' : 'new')
    setCode('')
    setWaitS(RESEND_AFTER_S)
  }
  const send = (to: string) =>
    request.run(async () => {
      if (!looksLikeEmail(to)) throw new Error(t('account.email.invalid'))
      if (to === current.toLowerCase()) throw new Error(t('account.email.same'))
      const { confirmCurrentEmail } = await requestEmailChange(to)
      codeSent(to, confirmCurrentEmail)
    })
  const submit = () => {
    if (!target) return void send(next)
    if (code.length !== CODE_LENGTH) return
    void request.run(async () => {
      if (step === 'current') {
        const { confirmCurrentEmail } = await requestEmailChange(target, code)
        return codeSent(target, confirmCurrentEmail)
      }
      await changeEmail(target, code)
      await onDone(target)
    })
  }

  // Enter in either input sends the code or changes the address; it must not submit the name around it.
  const onEnter = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return
    e.preventDefault()
    e.stopPropagation()
    if (!request.busy) submit()
  }

  return (
    <div className="ac-form ac-divided" role="group" aria-label={t('account.email.change')} onKeyDown={onEnter}>
      {target ? (
        <Field
          key={step}
          id="ac-email-code"
          label={t('account.email.code')}
          help={
            step === 'current'
              ? t('account.email.codeCurrent', { digits: CODE_LENGTH, email: current })
              : t('account.email.codeNew', { digits: CODE_LENGTH, email: target })
          }
          tip={step === 'current' ? t('account.email.codeCurrentTip') : undefined}
        >
          <div className="ac-inline">
            <span className="k-input">
              <input
                id="ac-email-code"
                name="code"
                value={code}
                onChange={e => setCode(normalizeCode(e.target.value))}
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={CODE_LENGTH + 6}
                autoFocus
              />
            </span>
            <Button
              size="sm"
              variant="ghost"
              title={step === 'current' ? t('account.email.resendCurrent') : t('account.email.resendNew')}
              disabled={request.busy || waitS > 0}
              onClick={() => void send(target)}
            >
              {waitS > 0 ? t('account.email.resendIn', { seconds: waitS }) : t('account.email.resend')}
            </Button>
          </div>
        </Field>
      ) : (
        <Field
          id="ac-new-email"
          label={t('account.email.newAddress')}
          help={t('account.email.newAddressHelp')}
          tip={t('account.email.newAddressTip')}
        >
          <span className="k-input">
            <input
              id="ac-new-email"
              name="email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="email"
              placeholder={t('account.email.placeholder')}
              autoFocus
            />
          </span>
        </Field>
      )}
      <FormStatus request={request} />
      <div className="ac-actions">
        <Button variant="ghost" title={t('account.email.keep')} disabled={request.busy} onClick={onCancel}>
          {t('common.action.cancel')}
        </Button>
        <Button
          busy={request.busy}
          variant="primary"
          title={
            !target
              ? t('account.email.sendTitle')
              : step === 'current'
                ? t('account.email.continueTitle')
                : t('account.email.changeTitle')
          }
          disabled={request.busy || (target ? code.length !== CODE_LENGTH : !next)}
          onClick={submit}
        >
          {!target
            ? t('account.email.send')
            : step === 'current'
              ? t('account.email.continue')
              : t('account.email.change')}
        </Button>
      </div>
    </div>
  )
}

/**
 * One sign-in method's header line: its name (a badge, the "?"), its state under it, and its one button at the right.
 * Sign-in & security is a list of these, each with what it opens below it (LIN-766).
 */
function MethodHead({
  title,
  badge,
  tip,
  state,
  action,
}: {
  title: string
  badge?: ReactNode
  tip?: string
  state?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="ac-method-head">
      <div className="ac-method-text">
        <span className="ac-method-title">
          <h3>{title}</h3>
          {badge}
          {tip && <HelpTip text={tip} />}
        </span>
        {state && <span className="help">{state}</span>}
      </div>
      {action && <div className="ac-actions">{action}</div>}
    </div>
  )
}

/** Password: Set or Not set, and Change (or Set password) opening the form in place; Esc or Cancel closes it. */
function PasswordForm({ account, reload }: SectionProps) {
  const t = useT()
  const exists = hasPassword(account.accounts)
  const empty = { current: '', next: '', repeat: '' }
  const [form, setForm] = useState(empty)
  const [open, setOpen] = useState(false)
  const request = useRequest()
  const set = (key: keyof typeof form) => (value: string) => setForm(f => ({ ...f, [key]: value }))
  const close = () => {
    setOpen(false)
    setForm(empty)
    request.dismiss()
  }
  const save = (e: FormEvent) => {
    e.preventDefault()
    const problem = passwordProblem(form, exists)
    if (problem) return request.setError(problem)
    void request.run(
      async () => {
        await (exists ? changePassword(form.current, form.next) : setFirstPassword(form.next))
        setForm(empty)
        setOpen(false)
        await reload()
      },
      exists ? t('account.password.changed') : t('account.password.set'),
    )
  }
  return (
    <div className="ac-form ac-divided">
      <MethodHead
        title={t('account.password.title')}
        state={exists ? t('account.password.stateSet') : t('account.password.stateNotSet')}
        action={
          !open && (
            <Button
              title={exists ? t('account.password.changeTitle') : t('account.password.setTitle')}
              onClick={() => {
                request.dismiss()
                setOpen(true)
              }}
            >
              {exists ? t('account.password.changeShort') : t('account.password.setButton')}
            </Button>
          )
        }
      />
      {open ? (
        <form
          className="ac-form"
          onSubmit={save}
          onKeyDown={e => {
            if (e.key !== 'Escape' || e.defaultPrevented) return
            e.preventDefault()
            e.stopPropagation()
            close()
          }}
        >
          {/* The account the password belongs to, for password managers: they update that login instead of saving a new one. */}
          <input type="email" name="username" autoComplete="username" value={account.user.email} readOnly hidden />
          <div className="row2">
            {exists && (
              <Field id="ac-pw-current" label={t('account.password.current')}>
                <PasswordInput
                  id="ac-pw-current"
                  value={form.current}
                  onChange={set('current')}
                  autoComplete="current-password"
                  autoFocus
                />
              </Field>
            )}
            <Field id="ac-pw-new" label={t('account.password.new')}>
              <PasswordInput
                id="ac-pw-new"
                value={form.next}
                onChange={set('next')}
                autoComplete="new-password"
                autoFocus={!exists}
              />
            </Field>
            <Field id="ac-pw-repeat" label={t('account.password.repeat')}>
              <PasswordInput
                id="ac-pw-repeat"
                value={form.repeat}
                onChange={set('repeat')}
                autoComplete="new-password"
              />
            </Field>
          </div>
          <FormStatus request={request} />
          <div className="ac-actions" hidden={Boolean(request.confirmPasskey)}>
            <Button variant="ghost" title={t('account.password.cancelTitle')} onClick={close}>
              {t('common.action.cancel')}
            </Button>
            <Button
              busy={request.busy}
              type="submit"
              variant="primary"
              title={exists ? t('account.password.changeTitle') : t('account.password.setTitle')}
              disabled={request.busy || !form.next}
            >
              {request.busy
                ? t('common.action.saving')
                : exists
                  ? t('account.password.change')
                  : t('account.password.setButton')}
            </Button>
          </div>
        </form>
      ) : (
        <FormStatus request={request} />
      )}
    </div>
  )
}

/** Sign-in & security: one block per way in, each with its button on its own header line. */
function SignIn(props: SectionProps) {
  const t = useT()
  const { methods } = props.account
  return (
    <Section id="ac-signin" title={t('account.nav.security.label')}>
      <div className="ac-methods">
        {methods.passkey && passkeySupported() && <Passkeys />}
        {methods.password && <PasswordForm {...props} />}
        <Authenticator />
      </div>
    </Section>
  )
}

/** The member's passkeys: add one for this device, remove one (both need a recent sign-in). */
function Passkeys() {
  const t = useT()
  const passkeys = useQuery(PASSKEYS, loadPasskeys)
  const list = passkeys.data
  const [confirming, setConfirming] = useState<string | null>(null)
  // Shared with the agent setup page (add-passkey.ts): the enrolment code, the device name, the same errors.
  const { needsCode, enrolmentCode, setEnrolmentCode, addThisDevice } = useAddPasskey()
  const request = useRequest()
  const load = passkeys.reload
  // None yet: the way in we recommend, so adding one is the main button here.
  const none = list?.length === 0

  const add = () => request.run(() => addThisDevice(load), t('account.passkeys.added'))
  const remove = (id: string) => {
    setConfirming(null)
    return request.run(async () => {
      await removePasskey(id)
      await load()
    }, t('account.passkeys.removed'))
  }
  // Waiting for the passkey: the note's Confirm is the one way on, so the other buttons step back.
  const waiting = Boolean(request.confirmPasskey)

  return (
    <div className="ac-form">
      <MethodHead
        title={t('account.passkeys.title')}
        tip={t('account.passkeys.tip')}
        badge={<Badge>{t('account.passkeys.recommended')}</Badge>}
        state={none ? t('auth.addPasskey.why') : undefined}
        action={
          !waiting && (
            <Button
              variant={none ? 'primary' : undefined}
              title={t('account.passkeys.addTitle')}
              disabled={request.busy}
              onClick={() => void add()}
            >
              {request.busy ? t('account.passkeys.waiting') : t('account.passkeys.add')}
            </Button>
          )
        }
      />
      <Loading
        what={t('account.passkeys.title')}
        loading={!list}
        error={passkeys.error}
        onRetry={() => void load()}
        skeleton={<ListSkeleton rows={1} quiet />}
      >
        {list && list.length > 0 && (
          <ul className="ac-list ac-quiet-list">
            {list.map(p => (
              <li key={p.id} className="ac-session">
                <div>
                  <b>{p.name}</b>
                  {p.added && (
                    <span className="help">{t('account.passkeys.addedAt', { when: dateTimeLabel(p.added) })}</span>
                  )}
                </div>
                <div className="ac-row-actions">
                  {waiting ? null : confirming === p.id ? (
                    <>
                      <span className="help">{t('account.passkeys.removeQuestion')}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        title={t('account.passkeys.keep')}
                        onClick={() => setConfirming(null)}
                      >
                        {t('common.action.cancel')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        title={t('account.passkeys.removeTitle')}
                        disabled={request.busy}
                        onClick={() => void remove(p.id)}
                      >
                        {t('account.passkeys.remove')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      title={t('account.passkeys.removeNamed', { name: p.name })}
                      onClick={() => setConfirming(p.id)}
                    >
                      {t('account.passkeys.remove')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Loading>
      {needsCode && (
        <Field label={t('account.passkeys.enrolmentCode')} tip={t('account.passkeys.enrolmentTip')}>
          <TextInput
            label={t('account.passkeys.enrolmentCode')}
            placeholder={t('account.passkeys.enrolmentPlaceholder')}
            value={enrolmentCode}
            onChange={setEnrolmentCode}
          />
        </Field>
      )}
      <FormStatus request={request} />
    </div>
  )
}

const AUTHENTICATOR = 'account.authenticator'

/**
 * A server admin's authenticator app (authenticator-api.ts): the fallback to the passkey for Server admin. Shown only
 * to instance admins (`hasAuthenticator` is null for everyone else). Only an admin with a passkey adds it, after the
 * passkey check (asked for in place); removing needs a checked session too.
 */
function Authenticator() {
  const t = useT()
  const me = useQuery(AUTHENTICATOR, fetchMe)
  const reload = me.reload
  const [justAdded, setJustAdded] = useState(false)
  const setup = useAuthenticatorSetup(async () => {
    await reload()
    setJustAdded(true)
  })
  const request = useRequest()
  const [confirming, setConfirming] = useState(false)
  const data = me.data
  if (!data || data.hasAuthenticator === null || data.hasAuthenticator === undefined) return null
  // The app is only the fallback to a passkey: without one there is nothing to add yet.
  const noPasskey = !data.hasPasskey
  // A passkey, but this session's check was not a passkey sign-in: confirm with the passkey first, in place.
  const passkeyFirst = Boolean(data.hasPasskey) && !data.passkeySignedIn

  const start = () =>
    request.run(async () => {
      if (passkeyFirst) await confirmWithPasskey()
      await setup.start()
      if (passkeyFirst) await reload()
    })
  const remove = () =>
    request.run(async () => {
      if (passkeyFirst) await confirmWithPasskey()
      await removeAuthenticator()
      setConfirming(false)
      await reload()
    }, t('account.authenticator.removed'))
  const idle = !setup.started && !request.confirmPasskey

  return (
    <div className="ac-form ac-divided">
      <MethodHead
        title={t('account.authenticator.title')}
        tip={t('account.authenticator.tip')}
        state={
          data.hasAuthenticator
            ? t('account.authenticator.stateOn', { hours: AUTHENTICATOR_HOURS })
            : noPasskey
              ? t('account.authenticator.stateNeedsPasskey')
              : t('account.authenticator.stateNone')
        }
        action={
          idle && (
            <>
              {!data.hasAuthenticator && !noPasskey && (
                <Button
                  title={t('account.authenticator.addTitle')}
                  disabled={request.busy || setup.busy}
                  onClick={() => void start()}
                >
                  {t('account.authenticator.setUp')}
                </Button>
              )}
              {data.hasAuthenticator && !confirming && (
                <Button title={t('account.authenticator.removeTitle')} onClick={() => setConfirming(true)}>
                  {t('account.authenticator.remove')}
                </Button>
              )}
              {data.hasAuthenticator && confirming && (
                <>
                  <span className="help">{t('account.authenticator.removeQuestion')}</span>
                  <Button variant="ghost" title={t('account.authenticator.keep')} onClick={() => setConfirming(false)}>
                    {t('common.action.cancel')}
                  </Button>
                  <Button
                    variant="danger"
                    title={t('account.authenticator.removeTitle')}
                    disabled={request.busy}
                    onClick={() => void remove()}
                  >
                    {t('account.authenticator.remove')}
                  </Button>
                </>
              )}
            </>
          )
        }
      />
      {setup.started && (
        <form
          className="ac-form"
          noValidate
          onSubmit={e => {
            e.preventDefault()
            void setup.confirm()
          }}
        >
          <AuthenticatorQr data={setup.started} />
          <Field label={t('account.authenticator.code')}>
            <Input
              aria-label={t('account.authenticator.code')}
              placeholder={t('account.authenticator.codePlaceholder')}
              value={setup.code}
              onChange={e => setup.setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              autoFocus
            />
          </Field>
          {setup.error && <Note tone="danger">{setup.error}</Note>}
          <div className="ac-actions">
            <Button variant="ghost" title={t('account.authenticator.cancel')} onClick={setup.cancel}>
              {t('common.action.cancel')}
            </Button>
            <Button
              type="submit"
              variant="primary"
              title={t('account.authenticator.confirmTitle')}
              disabled={setup.busy || setup.code.trim().length < 6}
            >
              {t('account.authenticator.confirm')}
            </Button>
          </div>
        </form>
      )}
      {!setup.started && (
        <>
          <FormStatus request={request} />
          {justAdded && data.hasAuthenticator && <Note tone="success">{t('account.authenticator.added')}</Note>}
          {setup.error && <Note tone="danger">{setup.error}</Note>}
        </>
      )}
    </div>
  )
}

/** A question with Cancel and a confirming button, in place of the button that asked it. */
function Confirm({
  question,
  busy,
  onCancel,
  onConfirm,
}: {
  question: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const t = useT()
  return (
    <>
      <span className="help">{question}</span>
      <Button size="sm" variant="ghost" title={t('account.sessions.keep')} onClick={onCancel}>
        {t('common.action.cancel')}
      </Button>
      <Button size="sm" variant="primary" title={t('account.sessions.signOutNow')} disabled={busy} onClick={onConfirm}>
        {t('account.sessions.signOut')}
      </Button>
    </>
  )
}

/** Sessions in the order shown; SignInAgain when the session is too old to list them. */
async function loadSessionList(): Promise<SessionRow[] | 'signInAgain'> {
  try {
    return orderSessions(await loadSessions())
  } catch (err) {
    if (err instanceof SignInAgain) return 'signInAgain'
    throw err
  }
}

/** Grey rows where a list of sessions or passkeys will be: the rows' own name, line under it and button. */
function ListSkeleton({ rows = 3, quiet = false }: { rows?: number; quiet?: boolean }) {
  return (
    <ul className={quiet ? 'ac-list ac-quiet-list' : 'ac-list'} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows never reorder
        <li key={i} className="ac-session">
          <div>
            <Skeleton shape="text" width={110 + ((i * 29) % 40)} />
            <Skeleton shape="text" width={150} />
          </div>
          <Skeleton width={64} height={28} />
        </li>
      ))}
    </ul>
  )
}

/** A section of the account while the account itself loads: its title at once, its fields in grey. */
function AccountSkeleton({
  current,
  hasWorkspace,
  error,
  retry,
}: {
  current: SectionId
  hasWorkspace: boolean
  error: string | null
  retry: () => void
}) {
  const t = useT()
  const skeleton =
    current === 'security' ? (
      <div className="ac-methods">
        <div className="ac-method-head">
          <div className="ac-method-text">
            <Skeleton shape="text" width={120} />
            <Skeleton shape="text" width={220} />
          </div>
          <Skeleton width={96} height={32} />
        </div>
        <div className="ac-method-head ac-divided">
          <div className="ac-method-text">
            <Skeleton shape="text" width={80} />
            <Skeleton shape="text" width={40} />
          </div>
          <Skeleton width={72} height={32} />
        </div>
      </div>
    ) : (
      <>
        {hasWorkspace && (
          <Field label={t('account.picture.label')}>
            <span className="ac-avatar">
              <Skeleton width={56} height={56} className="sk-round" />
              <Skeleton width={76} height={28} />
            </span>
          </Field>
        )}
        <Field label={t('account.profile.name')}>
          <Skeleton shape="field" width="100%" />
        </Field>
        <Field label={t('account.profile.email')}>
          <Skeleton shape="text" width={180} />
        </Field>
      </>
    )
  return (
    <Section
      id={current === 'security' ? 'ac-signin' : 'ac-profile'}
      title={current === 'security' ? t('account.nav.security.label') : t('account.nav.profile.label')}
    >
      <Loading what={t('account.yourAccount')} loading error={error} onRetry={retry} skeleton={skeleton} />
    </Section>
  )
}

function Sessions() {
  const t = useT()
  const query = useQuery(SESSIONS, loadSessionList)
  const list = query.data
  /** A session id, or 'others'. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const request = useRequest()
  const load = query.reload
  const sessions = Array.isArray(list) ? list : null

  const signOut = (action: () => Promise<void>, doneText: string) =>
    request.run(async () => {
      await action()
      setConfirming(null)
      await load()
    }, doneText)

  const others = sessions ? sessions.length - 1 : 0
  return (
    <Section id="ac-sessions" title={t('account.nav.sessions.label')}>
      {list === 'signInAgain' && (
        <div className="ac-inline">
          <span className="help">{t('account.sessions.signInAgain')}</span>
          <SignInAgainButton />
        </div>
      )}
      <Loading
        what={t('account.nav.sessions.label')}
        loading={!list}
        error={query.error}
        onRetry={() => void load()}
        skeleton={<ListSkeleton rows={3} />}
      >
        {sessions && (
          <ul className="ac-list">
            {(showAll ? sessions : sessions.slice(0, SESSIONS_SHOWN)).map(s => (
              <li key={s.id} className="ac-session">
                <div>
                  <b>{s.device}</b>
                  <span className="help">
                    {t('account.sessions.lastActive', { when: dateTimeLabel(s.lastActive) })}
                  </span>
                </div>
                <div className="ac-row-actions">
                  {s.current ? (
                    <Badge>{t('account.sessions.thisDevice')}</Badge>
                  ) : confirming === s.id ? (
                    <Confirm
                      question={t('account.sessions.signOutQuestion')}
                      busy={request.busy}
                      onCancel={() => setConfirming(null)}
                      onConfirm={() => void signOut(() => signOutSession(s.id), t('account.sessions.signedOut'))}
                    />
                  ) : (
                    <Button
                      size="sm"
                      title={t('account.sessions.signOutDevice', { device: s.device })}
                      onClick={() => setConfirming(s.id)}
                    >
                      {t('account.sessions.signOut')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Loading>
      {sessions && !showAll && sessions.length > SESSIONS_SHOWN && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
            {t('account.sessions.showMore', { count: sessions.length - SESSIONS_SHOWN })}
          </Button>
        </div>
      )}
      <FormStatus request={request} />
      {others > 0 && (
        <div className="ac-actions">
          {confirming === 'others' ? (
            <Confirm
              question={t('account.sessions.signOutOthersQuestion', { count: others })}
              busy={request.busy}
              onCancel={() => setConfirming(null)}
              onConfirm={() => void signOut(signOutOtherSessions, t('account.sessions.othersSignedOut'))}
            />
          ) : (
            <Button title={t('account.sessions.signOutOthersTitle')} onClick={() => setConfirming('others')}>
              {t('account.sessions.signOutOthers')}
            </Button>
          )}
        </div>
      )}
    </Section>
  )
}

// Notifications are a part of Preferences (`#account/notifications` opens it, useRoute.ts MOVED).
type SectionId = 'profile' | 'preferences' | 'security' | 'sessions' | 'apiKeys'
const SECTION_IDS: readonly SectionId[] = ['profile', 'preferences', 'security', 'sessions', 'apiKeys']

/** The page's sections in the active language; without a workspace Preferences is the language alone. */
function useSections(hasWorkspace: boolean): readonly PageSection<SectionId>[] {
  const t = useT()
  return useMemo(
    () =>
      SECTION_IDS.map(id => ({
        id,
        // i18n-dynamic: account.nav.*
        label: t(`account.nav.${id}.label` as MessageKey),
        description:
          id === 'preferences' && hasWorkspace
            ? t('account.nav.preferences.descriptionNotify')
            : t(`account.nav.${id}.description` as MessageKey),
      })),
    [t, hasWorkspace],
  )
}

type Props = {
  /** False on the screen without a workspace (NoWorkspace.tsx): no notifications under Preferences. */
  hasWorkspace: boolean
}

export function AccountSettings({ hasWorkspace }: Props) {
  const supportAccess = useImpersonating()
  // The person's profile, sign-in, sessions and own notifications are theirs alone, also with edits allowed: the server refuses them during
  // support access (impersonation-guard.ts), so nothing is loaded and the page says so calmly.
  return supportAccess ? (
    <SupportAccessAccount hasWorkspace={hasWorkspace} />
  ) : (
    <OwnAccount hasWorkspace={hasWorkspace} />
  )
}

/**
 * Terms · Privacy at the foot of the page (2026-11-18): not rows of the workspace menu, but always one click away in the
 * app. The same links as the sign-in page: this install's, or a white-label partner's in its client workspace
 * (useLegalLinks); nothing while they are not known or not set.
 */
export function AccountLegalLine() {
  const t = useT()
  const links = useLegalLinks()
  const items = [
    links?.terms && (
      <a key="terms" href={links.terms} target="_blank" rel="noreferrer">
        {t('common.legal.terms')}
      </a>
    ),
    links?.privacy && (
      <a key="privacy" href={links.privacy} target="_blank" rel="noreferrer">
        {t('common.legal.privacy')}
      </a>
    ),
  ].filter(Boolean)
  if (!items.length) return null
  return (
    <nav className="auth-legal ac-legal" aria-label={t('account.legal.label')}>
      {items}
    </nav>
  )
}

/** Account settings during support access: the sections, each saying it is the person's own. */
function SupportAccessAccount({ hasWorkspace }: Pick<Props, 'hasWorkspace'>) {
  const t = useT()
  const shown = useSections(hasWorkspace)
  const current = useSection('account', shown)
  const email = auth.useSession().data?.user.email ?? null
  return (
    <div className="page">
      <SettingsLayout
        page="account"
        title={t('account.title')}
        context={<span className="sl-context-text">{email}</span>}
        sections={shown}
        current={current}
      >
        <Note tone="info" title={t('account.supportAccess.title')}>
          {t('account.supportAccess.text')}
        </Note>
      </SettingsLayout>
    </div>
  )
}

/**
 * Sign-in methods, sessions and personal keys on a white-label partner's own address: managed at the install's own
 * address (host-sessions.ts), where a domain owner in the middle cannot see them; the page says where, with a link.
 */
function MainHostOnly({ section, origin }: { section: SectionId; origin: string }) {
  const t = useT()
  const host = new URL(origin).host
  return (
    // i18n-dynamic: account.nav.*
    <Section id={`ac-${section}`} title={t(`account.nav.${section}.label` as MessageKey)}>
      <Note
        tone="info"
        title={t('account.mainHost.title')}
        action={
          <a
            className="k-btn k-btn-secondary k-btn-sm"
            href={`${origin}/#account/${section}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t('account.mainHost.open', { host })}
          </a>
        }
      >
        {t('account.mainHost.text', { host })}
      </Note>
    </Section>
  )
}

function OwnAccount({ hasWorkspace }: Props) {
  const t = useT()
  const query = useQuery(ACCOUNT, loadAccount, { persist: true })
  const account = query.data
  // A changed password signs other sessions out, so the session list is loaded again too.
  const reload = useCallback(async () => {
    await Promise.all([query.reload(), refreshQuery(SESSIONS)])
  }, [query.reload])

  const shown = useSections(hasWorkspace)
  const current = useSection('account', shown)
  const props = account ? { account, reload } : null
  // On a white-label partner's own address: the install's own, where sign-in methods, sessions and keys are managed.
  const mainOrigin = account?.methods.mainOrigin
  return (
    <div className="page">
      <SettingsLayout
        page="account"
        title={t('account.title')}
        // The account's email as the context line, like the workspace's name on Workspace settings: both pages
        // start at the same height (C22); a bar of its width while the account loads.
        context={
          account ? (
            <span className="sl-context-text">{account.user.email}</span>
          ) : query.error ? null : (
            <SkeletonText width={180} />
          )
        }
        sections={shown}
        current={current}
      >
        {!props && (current === 'profile' || current === 'security') && (
          <AccountSkeleton
            current={current}
            hasWorkspace={hasWorkspace}
            error={query.error}
            retry={() => void query.reload()}
          />
        )}
        {props && current === 'profile' && <Profile {...props} hasWorkspace={hasWorkspace} />}
        {current === 'preferences' && (
          <Preferences locale={account?.user.locale} saved={() => void query.reload()} hasWorkspace={hasWorkspace} />
        )}
        {mainOrigin && (current === 'security' || current === 'sessions' || current === 'apiKeys') ? (
          <MainHostOnly section={current} origin={mainOrigin} />
        ) : (
          <>
            {props && current === 'security' && <SignIn {...props} />}
            {current === 'sessions' && <Sessions />}
            {current === 'apiKeys' && <PersonalKeys />}
          </>
        )}
        <AccountLegalLine />
      </SettingsLayout>
    </div>
  )
}
