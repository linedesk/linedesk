// Account: profile, notifications, sign-in and sessions of the signed-in member, one section at a time
// (#account/<section>). Profile, sign-in and sessions are Better Auth's own data (see account-api.ts), so they do
// not go through the outbox; notifications are per workspace (settings/Notifications.tsx).
import { forgetEnrolmentCode, readEnrolmentCode } from '../../enrolment-code.ts'
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useState } from 'react'
import { passkeySupported } from '../../auth.ts'
import { ConfirmEmail } from '../../ConfirmEmail.tsx'
import { signInAgain } from '../../localData.ts'
import { CODE_LENGTH, normalizeCode, RESEND_AFTER_S } from '../../sign-in-code.ts'
import { refreshQuery, useQuery } from '../../cachedQuery.ts'
import { refreshTeam } from '../../team/team-api.ts'
import { changedByLabel } from '../../team/team-model.ts'
import { Loading, Skeleton } from '../../ui/LoadStates.tsx'
import { dateTimeLabel } from '../../time.ts'
import { onSaveKey, SaveBar } from '../../ui/form.tsx'
import { Badge, Button, Note } from '../../ui/kit.tsx'
import { type PageSection, SettingsLayout, useSection } from '../../ui/SettingsLayout.tsx'
import { Field, Section, TextInput } from '../fields.tsx'
import { AvatarField } from './AvatarField.tsx'
import { Notifications } from '../Notifications.tsx'
import {
  ACCOUNT,
  type Account,
  addPasskey,
  PASSKEYS,
  SESSIONS,
  changeEmail,
  changeName,
  changePassword,
  ConfirmWithPasskey,
  confirmWithPasskey,
  loadAccount,
  loadPasskeyEnrolment,
  loadPasskeys,
  PASSKEY_ENROLMENT,
  loadSessions,
  removePasskey,
  requestEmailChange,
  setFirstPassword,
  SignInAgain,
  signOutOtherSessions,
  signOutSession,
} from './account-api.ts'
import {
  describeDevice,
  hasPassword,
  orderSessions,
  passwordProblem,
  type SessionRow,
  SESSIONS_SHOWN,
  signInMethodLabels,
} from './account-model.ts'

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
  return { busy, error, done, needsSignIn, confirmPasskey, setError: fail, run }
}
type Request = ReturnType<typeof useRequest>

function SignInAgainButton() {
  return (
    <Button title="Sign out and sign in again, then come back here" onClick={() => void signInAgain()}>
      Sign in again
    </Button>
  )
}

/** The outcome of a form's last request, next to the form that caused it. */
function FormStatus({
  request,
}: {
  request: Pick<Request, 'busy' | 'error' | 'done' | 'needsSignIn' | 'confirmPasskey'>
}) {
  if (request.error) {
    const { confirmPasskey } = request
    return (
      <div className="ac-inline">
        <Note tone="danger">{request.error}</Note>
        {confirmPasskey ? (
          <Button
            title="Sign in with one of your passkeys, then try again"
            disabled={request.busy}
            onClick={() => void confirmPasskey()}
          >
            Confirm with passkey
          </Button>
        ) : (
          request.needsSignIn && <SignInAgainButton />
        )}
      </div>
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
}: {
  id: string
  value: string
  onChange: (value: string) => void
  autoComplete: string
}) {
  return (
    <span className="k-input">
      <input
        id={id}
        type="password"
        value={value}
        autoComplete={autoComplete}
        onChange={e => onChange(e.target.value)}
      />
    </span>
  )
}

function Profile({ account, reload, hasWorkspace }: SectionProps & { hasWorkspace: boolean }) {
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
    }, 'Name saved.')
  }
  // `=== false`: an account remembered from before this field existed says nothing either way.
  const unconfirmed = account.user.emailVerified === false && account.methods.emailCode
  // The new address is proven with an email code, so it can only change where those are on.
  const canChangeEmail = account.methods.emailCode
  const [changingEmail, setChangingEmail] = useState(false)
  const [emailChanged, setEmailChanged] = useState<string | null>(null)
  return (
    <>
      {unconfirmed && (
        <ConfirmEmail
          email={account.user.email}
          onDone={reload}
          why={`Confirm that ${account.user.email} is yours. Until then you cannot create API keys or webhooks, invite people, or set up a carrier or phone number.`}
        />
      )}
      <form className="ac-form" onSubmit={save} onKeyDown={e => onSaveKey(e, dirty && !!trimmed)}>
        <Section id="ac-profile" title="Profile">
          {/* The picture is shown to the people you work with; without a workspace there is nobody to show it to. */}
          {hasWorkspace && <AvatarField name={account.user.name} avatarUrl={account.avatarUrl ?? null} />}
          <Field id="ac-name" label="Name" error={trimmed ? null : 'Enter your name.'}>
            <TextInput id="ac-name" value={name} onChange={setName} placeholder="Your name" invalid={!trimmed} />
          </Field>
          <Field
            label="Email"
            tip={
              canChangeEmail
                ? 'You sign in with this address, and sign-in codes and emails go to it. To change it, confirm the new address with a code.'
                : 'You sign in with this address, and sign-in codes and emails go to it.'
            }
          >
            <div className="ac-inline">
              <span className="ac-value">{account.user.email}</span>
              {canChangeEmail && !changingEmail && (
                <Button
                  size="sm"
                  title="Use a different email address for this account"
                  onClick={() => {
                    setEmailChanged(null)
                    setChangingEmail(true)
                  }}
                >
                  Change…
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
                setEmailChanged(`Email changed to ${next}. Your other sessions were signed out.`)
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
      if (!looksLikeEmail(to)) throw new Error('Enter a valid email address.')
      if (to === current.toLowerCase()) throw new Error('That is already your email address.')
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
    <div className="ac-form ac-divided" role="group" aria-label="Change email" onKeyDown={onEnter}>
      {target ? (
        <Field
          key={step}
          id="ac-email-code"
          label="Code"
          help={
            step === 'current'
              ? `Confirm it's you: enter the ${CODE_LENGTH}-digit code we sent to ${current}.`
              : `Enter the ${CODE_LENGTH}-digit code we sent to ${target}.`
          }
          tip={
            step === 'current'
              ? 'Your current address confirms the change first, so a stolen password alone cannot move your account. After a recent passkey sign-in, this step is skipped.'
              : undefined
          }
        >
          <div className="ac-inline">
            <span className="k-input">
              <input
                id="ac-email-code"
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
              title={
                step === 'current' ? 'Email a new code to your current address' : 'Email a new code to the new address'
              }
              disabled={request.busy || waitS > 0}
              onClick={() => void send(target)}
            >
              {waitS > 0 ? `New code in ${waitS} s` : 'Send a new code'}
            </Button>
          </div>
        </Field>
      ) : (
        <Field
          id="ac-new-email"
          label="New email address"
          help="We'll send a code to the new address. Your address changes once you enter it."
          tip="Unless you recently signed in with a passkey, your current address gets a code first to confirm it's you. If the new address already belongs to another account, no code comes; that address gets a notice instead. After the change, your old address gets a notice and your other sessions are signed out."
        >
          <span className="k-input">
            <input
              id="ac-new-email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              autoComplete="email"
              placeholder="you@example.com"
              autoFocus
            />
          </span>
        </Field>
      )}
      <FormStatus request={request} />
      <div className="ac-actions">
        <Button variant="ghost" title="Keep your current email address" disabled={request.busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          busy={request.busy}
          variant="primary"
          title={
            !target
              ? 'Email a code'
              : step === 'current'
                ? 'Confirm and email a code to the new address'
                : 'Change your email address to the new one'
          }
          disabled={request.busy || (target ? code.length !== CODE_LENGTH : !next)}
          onClick={submit}
        >
          {!target ? 'Send code' : step === 'current' ? 'Continue' : 'Change email'}
        </Button>
      </div>
    </div>
  )
}

function PasswordForm({ account, reload }: SectionProps) {
  const exists = hasPassword(account.accounts)
  const empty = { current: '', next: '', repeat: '' }
  const [form, setForm] = useState(empty)
  const request = useRequest()
  const set = (key: keyof typeof form) => (value: string) => setForm(f => ({ ...f, [key]: value }))
  const save = (e: FormEvent) => {
    e.preventDefault()
    const problem = passwordProblem(form, exists)
    if (problem) return request.setError(problem)
    void request.run(
      async () => {
        await (exists ? changePassword(form.current, form.next) : setFirstPassword(form.next))
        setForm(empty)
        await reload()
      },
      exists ? 'Password changed. Other sessions were signed out.' : 'Password set. Other sessions were signed out.',
    )
  }
  return (
    <form className="ac-form ac-divided" onSubmit={save}>
      {!exists && <span className="help">No password yet.</span>}
      <div className="row2">
        {exists && (
          <Field id="ac-pw-current" label="Current password">
            <PasswordInput
              id="ac-pw-current"
              value={form.current}
              onChange={set('current')}
              autoComplete="current-password"
            />
          </Field>
        )}
        <Field id="ac-pw-new" label="New password">
          <PasswordInput id="ac-pw-new" value={form.next} onChange={set('next')} autoComplete="new-password" />
        </Field>
        <Field id="ac-pw-repeat" label="Repeat new password">
          <PasswordInput id="ac-pw-repeat" value={form.repeat} onChange={set('repeat')} autoComplete="new-password" />
        </Field>
      </div>
      <FormStatus request={request} />
      <div className="ac-actions">
        <Button
          busy={request.busy}
          type="submit"
          variant="primary"
          title={exists ? 'Change your password and sign out your other sessions' : 'Set a password for this account'}
          disabled={request.busy || !form.next}
        >
          {request.busy ? 'Saving…' : exists ? 'Change password' : 'Set a password'}
        </Button>
      </div>
    </form>
  )
}

function SignIn(props: SectionProps) {
  const { accounts, methods } = props.account
  return (
    <Section id="ac-signin" title="Sign-in & security">
      <Field label="Methods">
        <div className="ac-badges">
          {signInMethodLabels(accounts, methods).map(label => (
            <Badge key={label}>{label}</Badge>
          ))}
        </div>
      </Field>
      {methods.passkey && passkeySupported() && <Passkeys />}
      {methods.password && <PasswordForm {...props} />}
    </Section>
  )
}

/** The member's passkeys: add one for this device, remove one (both need a recent sign-in). */
function Passkeys() {
  const passkeys = useQuery(PASSKEYS, loadPasskeys)
  const enrolment = useQuery(PASSKEY_ENROLMENT, loadPasskeyEnrolment)
  const list = passkeys.data
  const [confirming, setConfirming] = useState<string | null>(null)
  // The first admin's code came back with the setup (enrolment-code.ts): filled in, so adding the passkey is one click.
  const [enrolmentCode, setEnrolmentCode] = useState(() => readEnrolmentCode() ?? '')
  const request = useRequest()
  const load = passkeys.reload
  // An instance admin's first passkey needs the one-time code another admin (or the CLI) gave them.
  const needsCode = enrolment.data === true

  const add = () =>
    request.run(async () => {
      if (needsCode && !enrolmentCode.trim()) throw new Error('Enter your passkey enrolment code first.')
      await addPasskey(describeDevice(navigator.userAgent), needsCode ? enrolmentCode : undefined)
      forgetEnrolmentCode()
      setEnrolmentCode('')
      await Promise.all([load(), enrolment.reload()])
    }, 'Passkey added.')
  const remove = (id: string) =>
    request.run(async () => {
      await removePasskey(id)
      setConfirming(null)
      await load()
    }, 'Passkey removed.')

  return (
    <div className="ac-form ac-divided">
      <Field
        label="Passkeys"
        tip="A passkey lets you sign in with your fingerprint, face or device PIN instead of a code or password."
      >
        <Loading
          what="Passkeys"
          loading={!list}
          error={passkeys.error}
          onRetry={() => void load()}
          skeleton={<ListSkeleton rows={1} />}
        >
          {list && list.length === 0 && <span className="help">No passkeys yet.</span>}
          {list && list.length > 0 && (
            <ul className="ac-list">
              {list.map(p => (
                <li key={p.id} className="ac-session">
                  <div>
                    <b>{p.name}</b>
                    {p.added && <span className="help">Added {dateTimeLabel(p.added)}</span>}
                  </div>
                  <div className="ac-row-actions">
                    {confirming === p.id ? (
                      <>
                        <span className="help">Remove this passkey?</span>
                        <Button size="sm" variant="ghost" title="Keep this passkey" onClick={() => setConfirming(null)}>
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          title="Remove it; it no longer signs you in"
                          disabled={request.busy}
                          onClick={() => void remove(p.id)}
                        >
                          Remove
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" title={`Remove ${p.name}`} onClick={() => setConfirming(p.id)}>
                        Remove
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Loading>
      </Field>
      {needsCode && (
        <Field
          label="Enrolment code"
          tip="Because you are an instance admin, your first passkey needs a one-time code. The admin who made you an instance admin has it."
        >
          <TextInput
            label="Enrolment code"
            placeholder="From the admin who made you one"
            value={enrolmentCode}
            onChange={setEnrolmentCode}
          />
        </Field>
      )}
      <FormStatus request={request} />
      <div className="ac-actions">
        <Button
          title="Create a passkey on this device for your account"
          disabled={request.busy}
          onClick={() => void add()}
        >
          {request.busy ? 'Waiting for your device…' : 'Add passkey'}
        </Button>
      </div>
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
  return (
    <>
      <span className="help">{question}</span>
      <Button size="sm" variant="ghost" title="Keep it signed in" onClick={onCancel}>
        Cancel
      </Button>
      <Button size="sm" variant="primary" title="Sign out now" disabled={busy} onClick={onConfirm}>
        Sign out
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
function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="ac-list" aria-hidden="true">
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
  const skeleton =
    current === 'security' ? (
      <Field label="Methods">
        <span className="sk-inline">
          <Skeleton width={64} height={20} />
          <Skeleton width={72} height={20} />
        </span>
      </Field>
    ) : (
      <>
        {hasWorkspace && (
          <Field label="Picture">
            <span className="ac-avatar">
              <Skeleton width={56} height={56} className="sk-round" />
              <Skeleton width={76} height={28} />
            </span>
          </Field>
        )}
        <Field label="Name">
          <Skeleton shape="field" width="100%" />
        </Field>
        <Field label="Email">
          <Skeleton shape="text" width={180} />
        </Field>
      </>
    )
  return (
    <Section
      id={current === 'security' ? 'ac-signin' : 'ac-profile'}
      title={current === 'security' ? 'Sign-in & security' : 'Profile'}
    >
      <Loading what="Your account" loading error={error} onRetry={retry} skeleton={skeleton} />
    </Section>
  )
}

function Sessions() {
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
    <Section id="ac-sessions" title="Sessions">
      {list === 'signInAgain' && (
        <div className="ac-inline">
          <span className="help">Sign in again to see your devices.</span>
          <SignInAgainButton />
        </div>
      )}
      <Loading
        what="Sessions"
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
                  <span className="help">Last active {dateTimeLabel(s.lastActive)}</span>
                </div>
                <div className="ac-row-actions">
                  {s.current ? (
                    <Badge>This device</Badge>
                  ) : confirming === s.id ? (
                    <Confirm
                      question="Sign this device out?"
                      busy={request.busy}
                      onCancel={() => setConfirming(null)}
                      onConfirm={() => void signOut(() => signOutSession(s.id), 'Session signed out.')}
                    />
                  ) : (
                    <Button size="sm" title={`Sign out ${s.device}`} onClick={() => setConfirming(s.id)}>
                      Sign out
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
            Show {sessions.length - SESSIONS_SHOWN} more
          </Button>
        </div>
      )}
      <FormStatus request={request} />
      {others > 0 && (
        <div className="ac-actions">
          {confirming === 'others' ? (
            <Confirm
              question={`Sign out ${others} other ${others === 1 ? 'session' : 'sessions'}?`}
              busy={request.busy}
              onCancel={() => setConfirming(null)}
              onConfirm={() => void signOut(signOutOtherSessions, 'Other sessions signed out.')}
            />
          ) : (
            <Button title="Sign out everywhere except this device" onClick={() => setConfirming('others')}>
              Sign out all other sessions
            </Button>
          )}
        </div>
      )}
    </Section>
  )
}

type SectionId = 'profile' | 'notifications' | 'security' | 'sessions'
const sections: readonly PageSection<SectionId>[] = [
  { id: 'profile', label: 'Profile', description: 'Your picture and name' },
  { id: 'notifications', label: 'Notifications', description: 'New calls by email and on this device' },
  { id: 'security', label: 'Sign-in & security', description: 'Sign-in methods, passkeys and password' },
  { id: 'sessions', label: 'Sessions', description: 'Where you are signed in' },
]
/** Without a workspace there are no notifications to set. */
const sectionsWithoutWorkspace = sections.filter(s => s.id !== 'notifications')

type Props = {
  /** False on the screen without a workspace (NoWorkspace.tsx): no Notifications section. */
  hasWorkspace: boolean
  workspaceName?: string
}

export function AccountSettings({ hasWorkspace, workspaceName = '' }: Props) {
  const query = useQuery(ACCOUNT, loadAccount, { persist: true })
  const account = query.data
  // A changed password signs other sessions out, so the session list is loaded again too.
  const reload = useCallback(async () => {
    await Promise.all([query.reload(), refreshQuery(SESSIONS)])
  }, [query.reload])

  const shown = hasWorkspace ? sections : sectionsWithoutWorkspace
  const current = useSection('account', shown)
  const props = account ? { account, reload } : null
  return (
    <div className="page">
      <SettingsLayout page="account" title="Account settings" sections={shown} current={current}>
        {!props && (current === 'profile' || current === 'security') && (
          <AccountSkeleton
            current={current}
            hasWorkspace={hasWorkspace}
            error={query.error}
            retry={() => void query.reload()}
          />
        )}
        {props && current === 'profile' && <Profile {...props} hasWorkspace={hasWorkspace} />}
        {hasWorkspace && current === 'notifications' && <Notifications workspaceName={workspaceName} />}
        {props && current === 'security' && <SignIn {...props} />}
        {current === 'sessions' && <Sessions />}
      </SettingsLayout>
    </div>
  )
}
