// Settings, Developers: the workspace's API keys. The list is a cached read (cachedQuery.ts), so it
// shows at once from the last answer; creating shows the key once with Copy, revoking asks first.
// Keys reach /v1 (docs/api.md, GET /v1/openapi.json) with the role they were created with.
import type { ApiKeyCreated, ApiKeyListData, ApiKeySummary } from '@linedesk/actions'
import { type FormEvent, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { Dialog, Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { LoadProblem, SkeletonRows } from '../ui/LoadStates.tsx'
import { Field, Section } from './fields.tsx'
import { callAction, readAction } from './settings-api.ts'
import './developers.css'

const API_KEYS = 'apiKey.list'
const loadKeys = () => readAction<ApiKeyListData>('apiKey.list')

type Role = ApiKeySummary['role']
const roles: SelectOption<Role>[] = [
  { value: 'member', label: 'Member', description: 'Calls, contacts and bookings' },
  { value: 'admin', label: 'Admin', description: 'Also deleting, cancelling, blocking and spam in MCP tools' },
]

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

type Props = { canEdit: boolean; toast: (text: string) => void }

export function Developers({ canEdit, toast }: Props) {
  const keys = useQuery(canEdit ? API_KEYS : null, loadKeys, { persist: true })
  const [creating, setCreating] = useState(false)
  if (!canEdit)
    return (
      <Section id="st-api-keys" title="API keys">
        <p className="help">Only owners and admins can manage API keys.</p>
      </Section>
    )
  const active = keys.data?.keys.filter(k => !k.revoked_at) ?? []
  return (
    <Section
      id="st-api-keys"
      title="API keys"
      help="Send the key as Authorization: Bearer. REST API: /v1/openapi.json. MCP server: /mcp."
      actions={
        <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
          Create key
        </Button>
      }
    >
      {keys.data === undefined ? (
        keys.error ? (
          <LoadProblem what="API keys" message={keys.error} onRetry={() => void keys.reload()} />
        ) : (
          <SkeletonRows label="Loading API keys" rows={2} />
        )
      ) : active.length === 0 ? (
        <p className="help">No keys yet.</p>
      ) : (
        <ul className="dev-list">
          {active.map(k => (
            <KeyRow key={k.id} apiKey={k} toast={toast} />
          ))}
        </ul>
      )}
      {creating && <CreateKey onClose={() => setCreating(false)} toast={toast} />}
    </Section>
  )
}

function KeyRow({ apiKey, toast }: { apiKey: ApiKeySummary; toast: Props['toast'] }) {
  const [busy, setBusy] = useState(false)
  /** Revoke asks once in place (click again), like revoking an invitation: no browser dialog. */
  const [confirming, setConfirming] = useState(false)
  async function revoke() {
    if (!confirming) return setConfirming(true)
    setBusy(true)
    try {
      await callAction('apiKey.revoke', { apiKeyId: apiKey.id })
      setQueryData<ApiKeyListData | undefined>(API_KEYS, d => d && { keys: d.keys.filter(k => k.id !== apiKey.id) }, {
        persist: true,
      })
      toast(`${apiKey.name} is revoked.`)
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <li className="dev-row">
      <span className="dev-main">
        <b>{apiKey.name}</b>
        <span className="dev-sub">
          <code>{apiKey.prefix}…</code> · created {day(apiKey.created_at)} ·{' '}
          {apiKey.last_used_at ? `last used ${day(apiKey.last_used_at)}` : 'never used'}
        </span>
      </span>
      <Badge tone="outline">{apiKey.role === 'admin' ? 'Admin' : 'Member'}</Badge>
      <Button
        size="sm"
        variant={confirming ? 'danger' : 'ghost'}
        disabled={busy}
        onClick={revoke}
        onBlur={() => setConfirming(false)}
        title={confirming ? 'Click again: tools using it stop working at once' : `Revoke ${apiKey.name}`}
      >
        {confirming ? 'Revoke key' : 'Revoke'}
      </Button>
    </li>
  )
}

function CreateKey({ onClose, toast }: { onClose: () => void; toast: Props['toast'] }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const result = await callAction<ApiKeyCreated>('apiKey.create', { name: name.trim(), role })
      const summary: ApiKeySummary = {
        id: result.apiKeyId,
        name: name.trim(),
        prefix: result.prefix,
        role,
        created_by: '',
        created_at: new Date().toISOString(),
        last_used_at: null,
        revoked_at: null,
      }
      setQueryData<ApiKeyListData | undefined>(API_KEYS, d => ({ keys: [summary, ...(d?.keys ?? [])] }), {
        persist: true,
      })
      setCreated(result.key)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (created)
    return (
      <Dialog
        key="created" // a new dialog, so focus moves into it (Esc, Tab)
        title="Your API key"
        description="Shown only once. Copy it now."
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="dev-secret">
          <Input readOnly value={created} aria-label="API key" onFocus={e => e.currentTarget.select()} />
          <Button
            onClick={() =>
              navigator.clipboard.writeText(created).then(
                () => toast('Key copied.'),
                () => toast('Copy failed. Select the key instead.'),
              )
            }
          >
            Copy
          </Button>
        </div>
      </Dialog>
    )

  return (
    <Dialog
      title="Create API key"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
            {saving ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <Field id="dev-key-name" label="Name" error={error}>
        <Input
          id="dev-key-name"
          maxLength={60}
          placeholder="e.g. Zapier"
          value={name}
          invalid={Boolean(error)}
          onChange={e => setName(e.target.value)}
        />
      </Field>
      <Field id="dev-key-role" label="Access">
        <div>
          <Select id="dev-key-role" value={role} options={roles} onChange={setRole} label="Access" />
        </div>
      </Field>
    </Dialog>
  )
}
