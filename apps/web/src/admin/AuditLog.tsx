// Admin, Audit log: who did what on this install, newest first. Sign-ins with their method,
// sign-in methods added or removed, admin actions, team changes, provider keys and impersonation.
// Kept forever; filters by kind, person, workspace and dates; "Show older" pages back.
import { useCallback, useEffect, useState } from 'react'
import { dateTimeLabel } from '../time.ts'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { LoadProblem, SkeletonRows } from '../ui/LoadStates.tsx'
import { type AdminWorkspace, type AuditEntry, type AuditFilter, type AuditKind, loadAudit } from './api.ts'
import { errorText } from './notify.ts'

const kinds: SelectOption<AuditKind | 'all'>[] = [
  { value: 'all', label: 'Everything' },
  { value: 'sign_in', label: 'Sign-ins' },
  { value: 'account', label: 'Sign-in methods' },
  { value: 'admin', label: 'Admin actions' },
  { value: 'team', label: 'Team changes' },
  { value: 'keys', label: 'Provider keys' },
  { value: 'integrations', label: 'API keys and webhooks' },
  { value: 'impersonation', label: 'Signed in as a user' },
]

const methods: Record<string, string> = {
  password: 'password',
  email_code: 'email code',
  passkey: 'passkey',
  google: 'Google',
  microsoft: 'Microsoft',
  github: 'GitHub',
  oidc: 'single sign-on',
  email_link: 'email link',
}
const method = (m: string | null) => (m ? (methods[m] ?? m) : '')

/** What happened, in a few words. */
export function auditLabel(e: Pick<AuditEntry, 'what' | 'method' | 'input' | 'subject'>): string {
  const input = (e.input ?? {}) as Record<string, unknown>
  const who = e.subject?.email ?? 'a member'
  const invitee = e.subject?.email ?? 'someone'
  switch (e.what) {
    case 'sign_in':
      return `Signed in with ${method(e.method)}`
    case 'sign_up':
      return `Signed up with ${method(e.method)}`
    case 'provider_linked':
      return e.method === 'password' ? 'Set a password' : `Added ${method(e.method)} sign-in`
    case 'passkey_added':
      return 'Added a passkey'
    case 'passkey_removed':
      return 'Removed a passkey'
    case 'password_changed':
      return 'Changed the password'
    case 'invitation_accepted':
      return 'Joined a workspace'
    case 'user.impersonate':
      return 'Signed in as a user'
    case 'impersonation.stop':
      return 'Returned to admin'
    case 'provider.setKeys':
      return `Changed keys of ${String(input.provider ?? 'a provider')}`
    case 'provider.clearKeys':
      return `Removed keys of ${String(input.provider ?? 'a provider')}`
    case 'provider.setActive':
      return `Picked ${String(input.provider ?? 'none')} for ${String(input.category ?? 'a category')}`
    case 'team.setRole':
    case 'membership.setRole':
      return `Made ${who} ${roleName(input.role)}`
    case 'team.invite':
      return `Invited ${String(input.email ?? 'someone')}`
    case 'team.resendInvite':
    case 'invitation.resend':
      return `Sent the invitation to ${invitee} again`
    case 'team.revokeInvite':
    case 'invitation.revoke':
      return `Revoked the invitation to ${invitee}`
    case 'team.removeMember':
    case 'membership.remove':
      return `Removed ${who} from the workspace`
    case 'team.leave':
      return 'Left the workspace'
    case 'membership.add':
      return `Added ${who} as ${roleName(input.role)}`
    case 'invitation.accept':
      return 'Accepted an invitation'
    case 'invitation.decline':
      return 'Declined an invitation'
    case 'apiKey.create':
      return `Created API key ${quoted(input.name)}`.trim()
    case 'apiKey.revoke':
      return 'Revoked an API key'
    case 'webhook.create':
      return `Added a webhook to ${String(input.url ?? 'a URL')}`
    case 'webhook.update':
      return input.url ? `Changed a webhook to ${String(input.url)}` : 'Changed a webhook'
    case 'webhook.delete':
      return 'Removed a webhook'
    case 'webhook.test':
      return 'Sent a test to a webhook'
    default:
      return e.what
  }
}

/** "owner", "an admin", "a member": a role as it reads in a sentence. */
const roleName = (role: unknown) => (role === 'owner' ? 'owner' : role === 'admin' ? 'an admin' : 'a member')
const quoted = (name: unknown) => (typeof name === 'string' && name ? `“${name}”` : '')

const today = () => new Date().toISOString().slice(0, 10)
/** The day after, so "to" includes the whole day picked. */
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

export function AuditLog({ workspaces }: { workspaces: AdminWorkspace[] }) {
  const [filter, setFilter] = useState<{
    kind: AuditKind | 'all'
    who: string
    workspace: string
    from: string
    to: string
  }>({
    kind: 'all',
    who: '',
    workspace: 'all',
    from: '',
    to: '',
  })
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const query = useCallback(
    (before?: string): AuditFilter => ({
      ...(filter.kind !== 'all' ? { kind: filter.kind } : {}),
      ...(filter.who.trim() ? { who: filter.who.trim() } : {}),
      ...(filter.workspace !== 'all' ? { workspace: filter.workspace } : {}),
      ...(filter.from ? { from: filter.from } : {}),
      ...(filter.to ? { to: dayAfter(filter.to) } : {}),
      ...(before ? { before } : {}),
    }),
    [filter],
  )

  useEffect(() => {
    let live = true
    setEntries(null)
    setError(null)
    // Typing a name waits a moment before asking.
    const timer = setTimeout(() => {
      loadAudit(query()).then(
        page => {
          if (!live) return
          setEntries(page.entries)
          setNext(page.next)
        },
        err => live && setError(errorText(err)),
      )
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query])

  async function older() {
    if (!next) return
    setLoadingMore(true)
    try {
      const page = await loadAudit(query(next))
      setEntries(e => [...(e ?? []), ...page.entries])
      setNext(page.next)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setLoadingMore(false)
    }
  }

  const set =
    <K extends keyof typeof filter>(key: K) =>
    (value: (typeof filter)[K]) =>
      setFilter(f => ({ ...f, [key]: value }))
  const workspaceOptions: SelectOption<string>[] = [
    { value: 'all', label: 'All workspaces' },
    ...workspaces.map(w => ({ value: w.id, label: w.name })),
  ]

  return (
    <div className="adm-card">
      <div className="adm-audit-filters">
        <Select value={filter.kind} options={kinds} onChange={set('kind')} label="What" size="sm" />
        <Input
          className="adm-audit-who"
          value={filter.who}
          onChange={e => set('who')(e.target.value)}
          placeholder="Person (email or name)"
          aria-label="Person"
        />
        <Select
          value={filter.workspace}
          options={workspaceOptions}
          onChange={set('workspace')}
          label="Workspace"
          size="sm"
        />
        <Input
          type="date"
          value={filter.from}
          max={filter.to || today()}
          onChange={e => set('from')(e.target.value)}
          aria-label="From"
        />
        <Input
          type="date"
          value={filter.to}
          min={filter.from || undefined}
          max={today()}
          onChange={e => set('to')(e.target.value)}
          aria-label="To"
        />
      </div>
      {error && <LoadProblem what="The audit log" message={error} onRetry={() => setFilter(f => ({ ...f }))} />}
      {!error && entries === null && <SkeletonRows label="Loading" />}
      {entries && entries.length === 0 && <p className="adm-notice">No entries.</p>}
      {entries && entries.length > 0 && (
        <div className="adm-scroll">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">What</th>
                <th scope="col">Workspace</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td>
                    <time dateTime={e.at} title={new Date(e.at).toLocaleString('en-US')}>
                      {dateTimeLabel(new Date(e.at))}
                    </time>
                  </td>
                  <th scope="row">
                    {e.actor.email ?? (e.actor.id ? e.actor.id : 'Command line')}
                    {e.impersonatedBy && <span className="adm-sub">by {e.impersonatedBy.email ?? 'an admin'}</span>}
                  </th>
                  <td>
                    {auditLabel(e)}
                    {e.refused && (
                      <>
                        {' '}
                        <Badge tone="danger">Refused</Badge>
                      </>
                    )}
                    {e.ipAddress && <span className="adm-sub">{e.ipAddress}</span>}
                  </td>
                  <td>{e.workspace ? (e.workspace.name ?? e.workspace.id) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <div className="adm-audit-more">
          <Button size="sm" disabled={loadingMore} onClick={() => void older()} title="Load older entries">
            {loadingMore ? 'Loading…' : 'Show older'}
          </Button>
        </div>
      )}
    </div>
  )
}
