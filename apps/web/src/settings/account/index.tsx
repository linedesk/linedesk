// Account: profile, notifications, sign-in and sessions of the signed-in member, one section at a time
// (#account/<section>). Profile, sign-in and sessions are Better Auth's own data (see account-api.ts), so they do
// not go through the outbox; notifications are per workspace (settings/Notifications.tsx).
import type { MessageKey } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { passkeySupported } from '../../auth.ts'
import { ConfirmEmail } from '../../ConfirmEmail.tsx'
import { refreshQuery, useQuery } from '../../cachedQuery.ts'
import { signInAgain } from '../../localData.ts'
import { CODE_LENGTH, normalizeCode, RESEND_AFTER_S } from '../../sign-in-code.ts'
import { refreshTeam } from '../../team/team-api.ts'
import { changedByLabel } from '../../team/team-model.ts'
import { dateTimeLabel } from '../../time.ts'
import { onSaveKey, SaveBar } from '../../ui/form.tsx'
import { Badge, Button, Note } from '../../ui/kit.tsx'
import { Loading, Skeleton } from '../../ui/LoadStates.tsx'
import { type PageSection, SettingsLayout, useSection } from '../../ui/SettingsLayout.tsx'
import { Field, Section, TextInput } from '../fields.tsx'
import { Notifications } from '../Notifications.tsx'
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
import {
  hasPassword,
  orderSessions,
  passwordProblem,
  SESSIONS_SHOWN,
  type SessionRow,
  signInMethodLabels,
} from './account-model.ts'
import { useAddPasskey } from './add-passkey.ts'
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
  return { busy, error, done, needsSignIn, confirmPasskey, setError: fail, run }
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

/** The outcome of a form's last request, next to the form that caused it. */
function FormStatus({
  request,
}: {
  request: Pick<Request, 'busy' | 'error' | 'done' | 'needsSignIn' | 'confirmPasskey'>
}) {
  const t = useT()
  if (request.error) {
    const { confirmPasskey } = request
    return (
      <div className="ac-inline">
        <Note tone="danger">{request.error}</Note>
        {confirmPasskey ? (
          <Button
            title={t('account.confirmPasskey.title')}
            disabled={request.busy}
            onClick={() => void confirmPasskey()}
          >
            {t('account.confirmPasskey.button')}
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
  const canChangeEmail = account.methods.emailCode
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

function PasswordForm({ account, reload }: SectionProps) {
  const t = useT()
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
      exists ? t('account.password.changed') : t('account.password.set'),
    )
  }
  return (
    <form className="ac-form ac-divided" onSubmit={save}>
      <Field label={t('account.password.title')} help={exists ? undefined : t('account.password.none')}>
        <div className="row2">
          {exists && (
            <Field id="ac-pw-current" label={t('account.password.current')}>
              <PasswordInput
                id="ac-pw-current"
                value={form.current}
                onChange={set('current')}
                autoComplete="current-password"
              />
            </Field>
          )}
          <Field id="ac-pw-new" label={t('account.password.new')}>
            <PasswordInput id="ac-pw-new" value={form.next} onChange={set('next')} autoComplete="new-password" />
          </Field>
          <Field id="ac-pw-repeat" label={t('account.password.repeat')}>
            <PasswordInput id="ac-pw-repeat" value={form.repeat} onChange={set('repeat')} autoComplete="new-password" />
          </Field>
        </div>
      </Field>
      <FormStatus request={request} />
      <div className="ac-actions">
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
  )
}

function SignIn(props: SectionProps) {
  const t = useT()
  const { accounts, methods } = props.account
  return (
    <Section id="ac-signin" title={t('account.nav.security.label')}>
      <Field label={t('account.security.methods')}>
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
  const t = useT()
  const passkeys = useQuery(PASSKEYS, loadPasskeys)
  const list = passkeys.data
  const [confirming, setConfirming] = useState<string | null>(null)
  // Shared with the agent setup page (add-passkey.ts): the enrolment code, the device name, the same errors.
  const { needsCode, enrolmentCode, setEnrolmentCode, addThisDevice } = useAddPasskey()
  const request = useRequest()
  const load = passkeys.reload
  // None yet: the way in we recommend, so it says so and adding one is the main button here.
  const none = list?.length === 0

  const add = () => request.run(() => addThisDevice(load), t('account.passkeys.added'))
  const remove = (id: string) =>
    request.run(async () => {
      await removePasskey(id)
      setConfirming(null)
      await load()
    }, t('account.passkeys.removed'))

  return (
    <div className="ac-form ac-divided">
      <Field
        label={t('account.passkeys.title')}
        tip={t('account.passkeys.tip')}
        labelAfter={none && <Badge>{t('account.passkeys.recommended')}</Badge>}
      >
        <Loading
          what={t('account.passkeys.title')}
          loading={!list}
          error={passkeys.error}
          onRetry={() => void load()}
          skeleton={<ListSkeleton rows={1} />}
        >
          {none && <span className="help">{t('auth.addPasskey.why')}</span>}
          {list && list.length > 0 && (
            <ul className="ac-list">
              {list.map(p => (
                <li key={p.id} className="ac-session">
                  <div>
                    <b>{p.name}</b>
                    {p.added && (
                      <span className="help">{t('account.passkeys.addedAt', { when: dateTimeLabel(p.added) })}</span>
                    )}
                  </div>
                  <div className="ac-row-actions">
                    {confirming === p.id ? (
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
      </Field>
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
      <div className="ac-actions">
        <Button
          variant={none ? 'primary' : undefined}
          title={t('account.passkeys.addTitle')}
          disabled={request.busy}
          onClick={() => void add()}
        >
          {request.busy ? t('account.passkeys.waiting') : t('account.passkeys.add')}
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
  const t = useT()
  const skeleton =
    current === 'security' ? (
      <Field label={t('account.security.methods')}>
        <span className="sk-inline">
          <Skeleton width={64} height={20} />
          <Skeleton width={72} height={20} />
        </span>
      </Field>
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

type SectionId = 'profile' | 'preferences' | 'notifications' | 'security' | 'sessions'
const SECTION_IDS: readonly SectionId[] = ['profile', 'preferences', 'notifications', 'security', 'sessions']

/** The page's sections in the active language; without a workspace there are no notifications to set. */
function useSections(hasWorkspace: boolean): readonly PageSection<SectionId>[] {
  const t = useT()
  return useMemo(
    () =>
      SECTION_IDS.filter(id => hasWorkspace || id !== 'notifications').map(id => ({
        id,
        // i18n-dynamic: account.nav.*
        label: t(`account.nav.${id}.label` as MessageKey),
        description: t(`account.nav.${id}.description` as MessageKey),
      })),
    [t, hasWorkspace],
  )
}

type Props = {
  /** False on the screen without a workspace (NoWorkspace.tsx): no Notifications section. */
  hasWorkspace: boolean
  workspaceName?: string
}

export function AccountSettings({ hasWorkspace, workspaceName = '' }: Props) {
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
  return (
    <div className="page">
      <SettingsLayout page="account" title={t('account.title')} sections={shown} current={current}>
        {!props && (current === 'profile' || current === 'security') && (
          <AccountSkeleton
            current={current}
            hasWorkspace={hasWorkspace}
            error={query.error}
            retry={() => void query.reload()}
          />
        )}
        {props && current === 'profile' && <Profile {...props} hasWorkspace={hasWorkspace} />}
        {current === 'preferences' && <Preferences locale={account?.user.locale} saved={() => void query.reload()} />}
        {hasWorkspace && current === 'notifications' && <Notifications workspaceName={workspaceName} />}
        {props && current === 'security' && <SignIn {...props} />}
        {current === 'sessions' && <Sessions />}
      </SettingsLayout>
    </div>
  )
}
