// Workspace settings, Developers: the workspace's API keys. The list is a cached read (cachedQuery.ts), so it
// shows at once from the last answer; creating shows the key once with Copy, revoking asks first.
// Keys reach /v1 (docs/api.md, GET /v1/openapi.json) with the role they were created with.
import type { ApiKeyCreated, ApiKeyListData, ApiKeySummary } from '@linedesk/actions'
import { msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { Dialog, Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow } from '../ui/list.tsx'
import { Loading, SkeletonList } from '../ui/LoadStates.tsx'
import { Field, Section } from './fields.tsx'
import { callAction, readAction } from './settings-api.ts'
import './developers.css'
import { fmt } from '../i18n/format.ts'

const API_KEYS = 'apiKey.list'
const loadKeys = () => readAction<ApiKeyListData>('apiKey.list')

type Role = ApiKeySummary['role']
const ROLES = [
  {
    value: 'member',
    label: msg('settings.developers.role.member'),
    description: msg('settings.developers.role.memberHelp'),
  },
  {
    value: 'admin',
    label: msg('settings.developers.role.admin'),
    description: msg('settings.developers.role.adminHelp'),
  },
] as const

const day = (iso: string) => fmt().dateTime(new Date(iso), { month: 'short', day: 'numeric', year: 'numeric' })

type Props = { canEdit: boolean; toast: (text: string) => void }

export function Developers({ canEdit, toast }: Props) {
  const t = useT()
  const keys = useQuery(canEdit ? API_KEYS : null, loadKeys, { persist: true })
  const [creating, setCreating] = useState(false)
  if (!canEdit)
    return (
      <Section id="st-api-keys" title={t('settings.developers.title')}>
        <p className="help">{t('settings.developers.onlyAdmins')}</p>
      </Section>
    )
  const active = keys.data?.keys.filter(k => !k.revoked_at) ?? []
  return (
    <Section
      id="st-api-keys"
      title={t('settings.developers.title')}
      help={t('settings.developers.help', {
        header: 'Authorization: Bearer',
        openapi: '/v1/openapi.json',
        mcp: '/mcp',
      })}
      actions={
        <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
          {t('settings.developers.create')}
        </Button>
      }
    >
      <Loading
        what={t('settings.developers.title')}
        loading={keys.data === undefined}
        error={keys.error}
        onRetry={() => void keys.reload()}
        skeleton={<SkeletonList rows={1} aside action />}
      >
        {active.length === 0 ? (
          <ListEmpty>{t('settings.developers.empty')}</ListEmpty>
        ) : (
          <List label={t('settings.developers.title')}>
            {active.map(k => (
              <KeyRow key={k.id} apiKey={k} toast={toast} />
            ))}
          </List>
        )}
      </Loading>
      {creating && <CreateKey onClose={() => setCreating(false)} toast={toast} />}
    </Section>
  )
}

function KeyRow({ apiKey, toast }: { apiKey: ApiKeySummary; toast: Props['toast'] }) {
  const t = useT()
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
      toast(t('settings.developers.revoked', { name: apiKey.name }))
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <ListRow
      title={apiKey.name}
      sub={
        <>
          <code className="dev-prefix">{apiKey.prefix}…</code> ·{' '}
          {apiKey.last_used_at
            ? t('settings.developers.usedOn', { created: day(apiKey.created_at), used: day(apiKey.last_used_at) })
            : t('settings.developers.neverUsed', { created: day(apiKey.created_at) })}
        </>
      }
      aside={
        <Badge tone="outline">
          {apiKey.role === 'admin' ? t('settings.developers.role.admin') : t('settings.developers.role.member')}
        </Badge>
      }
      actions={
        <Button
          size="sm"
          variant={confirming ? 'danger' : 'ghost'}
          disabled={busy}
          onClick={revoke}
          onBlur={() => setConfirming(false)}
          title={
            confirming
              ? t('settings.developers.revokeConfirmTip')
              : t('settings.developers.revokeTip', { name: apiKey.name })
          }
        >
          {confirming ? t('settings.developers.revokeKey') : t('settings.developers.revoke')}
        </Button>
      }
    />
  )
}

function CreateKey({ onClose, toast }: { onClose: () => void; toast: Props['toast'] }) {
  const t = useT()
  const roles: SelectOption<Role>[] = ROLES.map(r => ({
    value: r.value,
    label: t(r.label),
    description: t(r.description),
  }))
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
        title={t('settings.developers.created.title')}
        description={t('settings.developers.created.description')}
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            {t('settings.developers.created.done')}
          </Button>
        }
      >
        <div className="dev-secret">
          <Input
            readOnly
            value={created}
            aria-label={t('settings.developers.created.key')}
            onFocus={e => e.currentTarget.select()}
          />
          <Button
            onClick={() =>
              navigator.clipboard.writeText(created).then(
                () => toast(t('settings.developers.created.copied')),
                () => toast(t('settings.developers.created.copyFailed')),
              )
            }
          >
            {t('common.copy.copy')}
          </Button>
        </div>
      </Dialog>
    )

  return (
    <Dialog
      title={t('settings.developers.dialog.title')}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t('common.action.cancel')}</Button>
          <Button busy={saving} type="submit" variant="primary" disabled={saving || !name.trim()}>
            {saving ? t('settings.developers.dialog.creating') : t('settings.developers.dialog.create')}
          </Button>
        </>
      }
    >
      <Field id="dev-key-name" label={t('settings.developers.dialog.name')} error={error}>
        <Input
          id="dev-key-name"
          maxLength={60}
          placeholder={t('settings.developers.dialog.namePlaceholder')}
          value={name}
          invalid={Boolean(error)}
          onChange={e => setName(e.target.value)}
        />
      </Field>
      <Field id="dev-key-role" label={t('settings.developers.dialog.access')}>
        <div>
          <Select
            id="dev-key-role"
            value={role}
            options={roles}
            onChange={setRole}
            label={t('settings.developers.dialog.access')}
          />
        </div>
      </Field>
    </Dialog>
  )
}
