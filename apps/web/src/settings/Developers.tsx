// Workspace settings, Developers: the workspace's API keys and what integrations (Zapier) subscribed with them. The list is a cached read (cachedQuery.ts), so it
// shows at once from the last answer; creating shows the key once with Copy, revoking asks first.
// Keys reach /v1 (docs/api.md, GET /v1/openapi.json) with the role they were created with.
import type {
  ApiKeyCreated,
  ApiKeyListData,
  ApiKeySummary,
  IntegrationListData,
  IntegrationSubscriptionSummary,
} from '@linedesk/actions'
import { msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useEffect, useState } from 'react'
import { pollWhileVisible, setQueryData, useQuery } from '../cachedQuery.ts'
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
/** How often the open list is checked again: a key made in another session (support access) shows without a reload. */
export const KEYS_POLL_MS = 15_000
const loadKeys = () => readAction<ApiKeyListData>('apiKey.list')
const INTEGRATIONS = 'integration.list'
const loadIntegrations = () => readAction<IntegrationListData>('integration.list')

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
  useEffect(() => (canEdit ? pollWhileVisible(API_KEYS, KEYS_POLL_MS) : undefined), [canEdit])
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

/** Zapier's subscriptions (integration.subscribe): one per Zap with a Linedesk trigger. Removing one stops its calls. */
export function Integrations({ canEdit, toast }: Props) {
  const t = useT()
  const list = useQuery(canEdit ? INTEGRATIONS : null, loadIntegrations, { persist: true })
  if (!canEdit) return null
  const subscriptions = list.data?.subscriptions ?? []
  return (
    <Section
      id="st-integrations"
      title={t('settings.developers.integrations.title')}
      help={t('settings.developers.integrations.help')}
    >
      <Loading
        what={t('settings.developers.integrations.title')}
        loading={list.data === undefined}
        error={list.error}
        onRetry={() => void list.reload()}
        skeleton={<SkeletonList rows={1} aside action />}
      >
        {subscriptions.length === 0 ? (
          <ListEmpty>{t('settings.developers.integrations.empty')}</ListEmpty>
        ) : (
          <List label={t('settings.developers.integrations.title')}>
            {subscriptions.map(s => (
              <SubscriptionRow key={s.id} subscription={s} toast={toast} />
            ))}
          </List>
        )}
      </Loading>
    </Section>
  )
}

function SubscriptionRow({
  subscription,
  toast,
}: {
  subscription: IntegrationSubscriptionSummary
  toast: Props['toast']
}) {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  async function remove() {
    if (!confirming) return setConfirming(true)
    setBusy(true)
    try {
      await callAction('integration.remove', { subscriptionId: subscription.id })
      setQueryData<IntegrationListData | undefined>(
        INTEGRATIONS,
        d => d && { subscriptions: d.subscriptions.filter(s => s.id !== subscription.id) },
        { persist: true },
      )
      toast(t('settings.developers.integrations.removed'))
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <ListRow
      title={t('settings.developers.integrations.zapierCallFinished')}
      sub={
        <>
          {t('settings.developers.integrations.viaKey', { name: subscription.api_key_name })}{' '}
          <code className="dev-prefix">{subscription.api_key_prefix}…</code> ·{' '}
          {subscription.last_delivery_at
            ? t('settings.developers.usedOn', {
                created: day(subscription.created_at),
                used: day(subscription.last_delivery_at),
              })
            : t('settings.developers.neverUsed', { created: day(subscription.created_at) })}
        </>
      }
      aside={
        subscription.status === 'disabled' && (
          <Badge tone="outline" title={subscription.disabled_reason ?? undefined}>
            {t('settings.developers.integrations.switchedOff')}
          </Badge>
        )
      }
      actions={
        <Button
          size="sm"
          variant={confirming ? 'danger' : 'ghost'}
          disabled={busy}
          onClick={remove}
          onBlur={() => setConfirming(false)}
          title={
            confirming
              ? t('settings.developers.integrations.removeConfirmTip')
              : t('settings.developers.integrations.removeTip')
          }
        >
          {confirming
            ? t('settings.developers.integrations.removeConfirm')
            : t('settings.developers.integrations.remove')}
        </Button>
      }
    />
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
      // Revoking ends what the key subscribed (Zapier): the list below shows it at once.
      setQueryData<IntegrationListData | undefined>(
        INTEGRATIONS,
        d => d && { subscriptions: d.subscriptions.filter(s => s.api_key_id !== apiKey.id) },
        { persist: true },
      )
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
      below={
        apiKey.created_during_support && (
          <p className="dev-support" title={t('settings.developers.supportAccessTip')}>
            {apiKey.created_during_support_by
              ? t('settings.developers.supportAccessBy', { name: apiKey.created_during_support_by })
              : t('settings.developers.supportAccess')}
          </p>
        )
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
        // Made during support access is for the server to say: the list is read again below.
        created_during_support: false,
        created_during_support_by: null,
      }
      setQueryData<ApiKeyListData | undefined>(API_KEYS, d => ({ keys: [summary, ...(d?.keys ?? [])] }), {
        persist: true,
      })
      setCreated(result.key)
      void loadKeys()
        .then(d => setQueryData<ApiKeyListData | undefined>(API_KEYS, d, { persist: true }))
        .catch(() => {})
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
