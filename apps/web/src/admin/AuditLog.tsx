// Server admin › Audit log: who did what on this install, newest first. Sign-ins with their method,
// sign-in methods added or removed, admin actions, team changes, provider keys and impersonation.
// Kept forever; filters by kind, person, workspace and dates; "Show older" pages back.
import { useCallback, useEffect, useState } from 'react'
import { dateTimeLabel } from '../time.ts'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { DateInput, Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { type AdminWorkspace, type AuditEntry, type AuditFilter, type AuditKind, loadAudit } from './api.ts'
import { errorText } from './notify.ts'

const kinds: SelectOption<AuditKind | 'all'>[] = [
  { value: 'all', label: 'Everything' },
  { value: 'sign_in', label: 'Sign-ins' },
  { value: 'account', label: 'Sign-in methods' },
  { value: 'admin', label: 'Admin actions' },
  { value: 'team', label: 'Team changes' },
  { value: 'keys', label: 'Provider keys' },
  { value: 'integrations', label: 'API keys, webhooks and AI agent setup' },
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
    case 'email_changed':
      return e.method ? `Changed the email address to ${e.method}` : 'Changed the email address'
    case 'invitation_accepted':
      return e.method === 'admin_created' ? 'Joined a workspace a server admin added them to' : 'Joined a workspace'
    case 'sign_up_undone':
      return 'Account removed again: its invitation was gone'
    case 'call_routing_reset':
      return 'Warm transfer and call forwarding reset when the address was proven'
    case 'user.impersonate':
      return 'Signed in as a user'
    case 'impersonation.stop':
      return 'Returned to admin'
    case 'provider.setKeys':
      return `Changed keys of ${String(input.provider ?? 'a provider')}`
    case 'provider.clearKeys':
      return `Removed keys of ${String(input.provider ?? 'a provider')}`
    case 'branding.set': {
      const changed = `Changed the branding to ${quoted(input.name)}`.trim()
      return input.poweredBy === false ? `${changed}, Powered by Linedesk hidden` : changed
    }
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
    case 'team.updateMemberProfile':
      return `Changed the name of ${who}`
    case 'team.setMemberAvatar':
      return `Changed the picture of ${who}`
    case 'team.removeMemberAvatar':
      return `Removed the picture of ${who}`
    case 'team.updateMemberNotifications':
      return `Changed the notifications of ${who} (${changedFields(input)})`
    case 'user.invite':
      return input.workspaceId
        ? `Added ${String(input.email ?? who)} as ${roleName(input.role ?? 'member')}${input.admin ? ' and server admin' : ''}`
        : `Added ${String(input.email ?? 'someone')}${input.admin ? ' as server admin' : ''}`
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
      return `Added a webhook to ${hostOf(input.url)}`
    case 'webhook.update':
      return input.url ? `Changed a webhook to ${hostOf(input.url)}` : 'Changed a webhook'
    case 'workspace.delete':
      return `Deleted the workspace ${quoted(input.name)}`.trim()
    case 'user.resetPasskeys':
      return "Reset a user's passkeys"
    case 'user.issuePasskeyEnrolment':
      return "Issued an admin's first passkey code"
    case 'webhook.delete':
      return 'Removed a webhook'
    case 'webhook.test':
      return 'Sent a test to a webhook'
    case 'agentSetup.endOwnAccess':
      return 'AI agent ended its own setup link'
    case 'agentSetup.createKey':
      return 'Created an AI agent setup link'
    case 'agentSetup.revoke':
      return 'Ended AI agent setup links'
    // The Allow step, gone since the one-level setup link; past entries still show.
    case 'agentSetup.confirmPasskey':
      return 'Allowed email and sign-in for an AI agent (old)'
    case 'agentSetup.withdrawPasskey':
      return 'Withdrew email and sign-in for an AI agent (old)'
    case 'provider.connectOneKey':
      return `Connected ${String(input.provider ?? 'a provider')} with one key`
    case 'carrier.set':
      return "Changed the workspace's own carrier account"
    case 'carrier.provisionTransferTrunk':
      return 'Set up the transfer line at the carrier'
    // These take only a user id: the address is the subject their handlers keep; older entries have none.
    case 'user.disable':
      return e.subject?.email ? `Disabled ${e.subject.email}` : 'Disabled a user'
    case 'user.enable':
      return e.subject?.email ? `Enabled ${e.subject.email}` : 'Enabled a user'
    case 'instanceAdmin.grant':
      return `Made ${e.subject?.email ?? 'someone'} a server admin`
    case 'instanceAdmin.revoke':
      return `Removed ${e.subject?.email ?? 'someone'} as server admin`
    case 'workspace.disable':
      return 'Disabled the workspace'
    case 'workspace.enable':
      return 'Enabled the workspace'
    case 'workspace.setSpendingCap':
      return input.capUsd == null ? 'Removed the spending cap' : `Set the spending cap to $${String(input.capUsd)}`
    case 'team.transferOwnership':
      return `Handed the workspace over to ${who}`
    case 'workspace.deleteOwn':
      return withName('Owner deleted the workspace', input.name)
    case 'workspace.create':
      return `${withName('Created the workspace', input.name)} with owner ${who}`
    case 'voiceCloning.set':
      return 'Changed voice cloning for the server'
    case 'voicePipelinePolicy.set':
      return 'Changed who picks how calls are answered'
    case 'setupEmails.set':
      return 'Changed the setup emails'
    case 'calendar.connectFinish':
      return calendarNames[String(input.provider)]
        ? `Connected a ${calendarNames[String(input.provider)]} calendar`
        : 'Connected a calendar'
    case 'calendar.disconnect':
      return 'Disconnected a calendar'
    case 'phoneNumber.setup':
      return input.purchase ? 'Bought a phone number' : 'Connected a phone number'
    case 'phoneNumber.release':
      return 'Released a phone number'
    default:
      return e.what
  }
}

const calendarNames: Record<string, string> = { google: 'Google', microsoft: 'Microsoft' }
/** "Created the workspace “Brightwater”", or without the name when the entry has none. */
const withName = (text: string, name: unknown) => `${text} ${quoted(name)}`.trim()

/** A webhook URL's host only: its path or query can carry a bearer token (the API sends only the host already). */
const hostOf = (url: unknown) => {
  try {
    return new URL(String(url)).host || 'a URL'
  } catch {
    return typeof url === 'string' && url && !url.includes('/') ? url : 'a URL'
  }
}

/** Which notification settings a change named: "email for every call, setup emails". */
const notificationFields: Record<string, string> = {
  email: 'email for every call',
  assignedEmail: 'assigned-call email',
  setupEmails: 'setup emails',
  pushSummary: 'push summary',
}
const changedFields = (input: Record<string, unknown>) =>
  Object.keys(notificationFields)
    .filter(key => input[key] !== undefined)
    .map(key => notificationFields[key])
    .join(', ') || 'none'

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
        <Select value={filter.kind} options={kinds} onChange={set('kind')} label="What" />
        <Input
          className="adm-audit-who"
          value={filter.who}
          onChange={e => set('who')(e.target.value)}
          placeholder="Person (email or name)"
          aria-label="Person"
        />
        <Select value={filter.workspace} options={workspaceOptions} onChange={set('workspace')} label="Workspace" />
        <DateInput
          value={filter.from}
          max={filter.to || today()}
          onChange={set('from')}
          placeholder="From"
          aria-label="From"
        />
        <DateInput
          value={filter.to}
          min={filter.from || undefined}
          max={today()}
          onChange={set('to')}
          placeholder="To"
          aria-label="To"
        />
      </div>
      {(error || entries === null) && (
        <Loading
          what="The audit log"
          loading
          error={error}
          onRetry={() => setFilter(f => ({ ...f }))}
          skeleton={<SkeletonRows rows={8} columns={4} className="adm-sk-rows" />}
        />
      )}
      {!error && entries && entries.length === 0 && <p className="adm-notice">No entries.</p>}
      {!error && entries && entries.length > 0 && (
        <div className="adm-scroll">
          <table className="adm-table adm-stack">
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
                  <td data-label="When">
                    <time dateTime={e.at} title={new Date(e.at).toLocaleString('en-US')}>
                      {dateTimeLabel(new Date(e.at))}
                    </time>
                  </td>
                  <th scope="row">
                    {e.actor.email ?? (e.actor.id ? e.actor.id : 'Command line')}
                    {e.impersonatedBy && <span className="adm-sub">by {e.impersonatedBy.email ?? 'an admin'}</span>}
                    {e.viaSetupKey && <span className="adm-sub">via AI agent setup link</span>}
                  </th>
                  <td data-label="What">
                    {auditLabel(e)}
                    {e.refused && (
                      <>
                        {' '}
                        <Badge tone="danger">Refused</Badge>
                      </>
                    )}
                    {e.ipAddress && <span className="adm-sub">{e.ipAddress}</span>}
                  </td>
                  <td data-label="Workspace">{e.workspace ? (e.workspace.name ?? e.workspace.id) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && (
        <div className="adm-audit-more">
          <Button
            busy={loadingMore}
            size="sm"
            disabled={loadingMore}
            onClick={() => void older()}
            title="Load older entries"
          >
            Show older
          </Button>
        </div>
      )}
    </div>
  )
}
