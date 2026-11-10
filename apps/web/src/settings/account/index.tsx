// Account settings: profile, sign-in and sessions of the signed-in member. Everything here is
// Better Auth's own data (see account-api.ts), so it does not go through the outbox.
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { signInAgain } from '../../auth.ts'
import { dateTimeLabel } from '../../time.ts'
import { Badge, Button } from '../../ui/kit.tsx'
import { Field, Section, TextInput } from '../fields.tsx'
import { type Account, changeName, changePassword, loadAccount, loadSessions, setFirstPassword, SignInAgain, signOutOtherSessions, signOutSession } from './account-api.ts'
import { hasPassword, orderSessions, passwordProblem, type SessionRow, signInMethodLabels } from './account-model.ts'

type SectionProps = { account: Account; reload: () => Promise<void> }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Runs one request at a time and keeps its outcome (an error, or what was done) for the form to show. */
function useRequest() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [needsSignIn, setNeedsSignIn] = useState(false)
  async function run(request: () => Promise<void>, doneText?: string) {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      await request()
      setDone(doneText ?? null)
    } catch (err) {
      setNeedsSignIn(err instanceof SignInAgain)
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }
  const fail = (text: string | null) => { setDone(null); setError(text) }
  return { busy, error, done, needsSignIn, setError: fail, run }
}
type Request = ReturnType<typeof useRequest>

function SignInAgainButton() {
  return <Button title="Sign out and sign in again, then come back here" onClick={() => void signInAgain()}>Sign in again</Button>
}

/** The outcome of a form's last request, next to the form that caused it. */
function FormStatus({ request }: { request: Pick<Request, 'error' | 'done' | 'needsSignIn'> }) {
  if (request.error) {
    return (
      <div className="ac-inline">
        <div className="ac-error" role="alert">{request.error}</div>
        {request.needsSignIn && <SignInAgainButton />}
      </div>
    )
  }
  return request.done ? <span className="help" role="status">{request.done}</span> : null
}

/** A password field in the kit's input frame; its label is the surrounding Field. */
function PasswordInput({ id, value, onChange, autoComplete }: { id: string; value: string; onChange: (value: string) => void; autoComplete: string }) {
  return <span className="k-input"><input id={id} type="password" value={value} autoComplete={autoComplete} onChange={e => onChange(e.target.value)} /></span>
}

function Profile({ account, reload }: SectionProps) {
  const [name, setName] = useState(account.user.name)
  const request = useRequest()
  const trimmed = name.trim()
  const save = (e: FormEvent) => {
    e.preventDefault()
    void request.run(async () => {
      await changeName(trimmed)
      await reload()
    }, 'Name saved.')
  }
  return (
    <Section id="ac-profile" title="Profile" description="How you appear to your team.">
      <form className="ac-form" onSubmit={save}>
        <Field id="ac-name" label="Name">
          <div className="ac-inline">
            <TextInput id="ac-name" value={name} onChange={setName} placeholder="Your name" />
            <Button type="submit" variant="primary" title="Save your name" disabled={request.busy || !trimmed || trimmed === account.user.name}>Save</Button>
          </div>
        </Field>
        <FormStatus request={request} />
      </form>
      <Field label="Email" help="You sign in with this address. It cannot be changed here yet.">
        <span className="ac-value">{account.user.email}</span>
      </Field>
    </Section>
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
    void request.run(async () => {
      await (exists ? changePassword(form.current, form.next) : setFirstPassword(form.next))
      setForm(empty)
      await reload()
    }, exists ? 'Password changed. Your other sessions were signed out.' : 'Password set. Your other sessions were signed out.')
  }
  return (
    <form className="ac-form ac-divided" onSubmit={save}>
      {!exists && <span className="help">You have no password yet. Set one to also sign in with email and password.</span>}
      <div className="row2">
        {exists && <Field id="ac-pw-current" label="Current password"><PasswordInput id="ac-pw-current" value={form.current} onChange={set('current')} autoComplete="current-password" /></Field>}
        <Field id="ac-pw-new" label="New password"><PasswordInput id="ac-pw-new" value={form.next} onChange={set('next')} autoComplete="new-password" /></Field>
        <Field id="ac-pw-repeat" label="Repeat new password"><PasswordInput id="ac-pw-repeat" value={form.repeat} onChange={set('repeat')} autoComplete="new-password" /></Field>
      </div>
      <FormStatus request={request} />
      <div className="ac-actions">
        <Button type="submit" variant="primary" title={exists ? 'Change your password and sign out your other sessions' : 'Set a password for this account'} disabled={request.busy || !form.next}>
          {exists ? 'Change password' : 'Set a password'}
        </Button>
      </div>
    </form>
  )
}

function SignIn(props: SectionProps) {
  const { accounts, methods } = props.account
  return (
    <Section id="ac-signin" title="Sign-in" description="How you get into Linedesk.">
      <Field label="Methods">
        <div className="ac-badges">{signInMethodLabels(accounts, methods).map(label => <Badge key={label}>{label}</Badge>)}</div>
      </Field>
      {methods.password && <PasswordForm {...props} />}
    </Section>
  )
}

/** A question with Cancel and a confirming button, in place of the button that asked it. */
function Confirm({ question, busy, onCancel, onConfirm }: { question: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <>
      <span className="help">{question}</span>
      <Button size="sm" variant="ghost" title="Keep it signed in" onClick={onCancel}>Cancel</Button>
      <Button size="sm" variant="primary" title="Sign out now" disabled={busy} onClick={onConfirm}>Sign out</Button>
    </>
  )
}

type SessionList = { state: 'loading' } | { state: 'signInAgain' } | { state: 'failed'; error: string } | { state: 'ready'; sessions: SessionRow[] }

function Sessions() {
  const [list, setList] = useState<SessionList>({ state: 'loading' })
  /** A session id, or 'others'. */
  const [confirming, setConfirming] = useState<string | null>(null)
  const request = useRequest()
  const load = useCallback(async () => {
    try {
      setList({ state: 'ready', sessions: orderSessions(await loadSessions()) })
    } catch (err) {
      setList(err instanceof SignInAgain ? { state: 'signInAgain' } : { state: 'failed', error: message(err) })
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const signOut = (action: () => Promise<void>, doneText: string) => request.run(async () => {
    await action()
    setConfirming(null)
    await load()
  }, doneText)

  const others = list.state === 'ready' ? list.sessions.length - 1 : 0
  return (
    <Section id="ac-sessions" title="Sessions" description="Where you are signed in.">
      {list.state === 'signInAgain' && (
        <div className="ac-inline">
          <span className="help">Sign in again to see your devices. For your security the list is only shown for a day after signing in.</span>
          <SignInAgainButton />
        </div>
      )}
      {list.state === 'failed' && <div className="ac-error" role="alert">{list.error}</div>}
      {list.state === 'ready' && (
        <ul className="ac-list">
          {list.sessions.map(s => (
            <li key={s.id} className="ac-session">
              <div><b>{s.device}</b><span className="help">Last active {dateTimeLabel(s.lastActive)}</span></div>
              <div className="ac-row-actions">
                {s.current ? <Badge>This device</Badge>
                  : confirming === s.id ? <Confirm question="Sign this device out?" busy={request.busy} onCancel={() => setConfirming(null)} onConfirm={() => void signOut(() => signOutSession(s.id), 'Session signed out.')} />
                  : <Button size="sm" title={`Sign out ${s.device}`} onClick={() => setConfirming(s.id)}>Sign out</Button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <FormStatus request={request} />
      {others > 0 && (
        <div className="ac-actions">
          {confirming === 'others'
            ? <Confirm question={`Sign out ${others} other ${others === 1 ? 'session' : 'sessions'}?`} busy={request.busy} onCancel={() => setConfirming(null)} onConfirm={() => void signOut(signOutOtherSessions, 'Other sessions signed out.')} />
            : <Button title="Sign out everywhere except this device" onClick={() => setConfirming('others')}>Sign out all other sessions</Button>}
        </div>
      )}
    </Section>
  )
}

/** The shell renders this for the `account` route, without props. */
export function AccountSettings() {
  const [account, setAccount] = useState<Account | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Counts reloads: a changed password signs other sessions out, so the session list starts over.
  const [version, setVersion] = useState(0)
  const reload = useCallback(async () => {
    await loadAccount().then(setAccount, err => setError(message(err)))
    setVersion(v => v + 1)
  }, [])
  useEffect(() => {
    void reload()
  }, [reload])

  if (!account) return <div className="page">{error && <div className="empty"><b>Could not load your account</b><span>{error}</span></div>}</div>
  const props = { account, reload }
  return (
    <div className="page">
      <div className="page-in st-page">
        <div className="page-head"><div><h1>Account</h1><p>Your profile, sign-in and sessions.</p></div></div>
        <Profile {...props} />
        <SignIn {...props} />
        <Sessions key={version} />
      </div>
    </div>
  )
}
