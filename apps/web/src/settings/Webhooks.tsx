// Assistant settings, Webhooks: the assistant's webhook, one address with the hooks it gets switched on.
// When a call starts, Linedesk asks it about the caller; during the call, the assistant asks its lookups
// (WebhookLookups.tsx); after the call, it sends the whole call (docs/webhooks.md). The webhook comes from the local store (synced, no secret), so it is there at once.
// Adding it shows its signing secret once; the hook switches and on/off go through the outbox; add,
// test-send and delete need the server's answer.
import {
  CALL_END_DELAY_SEC,
  CALL_START_TIMEOUT_MS,
  DURING_CALL_TIMEOUT_MS,
  newWebhookSecret,
  type WebhookDeliveriesData,
  type WebhookDeliverySummary,
  type WebhookTestData,
  webhookHooks,
} from '@linedesk/actions'
import type { CallerDetails, WebhookEndpoint, WebhookHook } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, Fragment, useEffect, useState } from 'react'
import { useRows, useRun } from '../store.tsx'
import { Loading, SkeletonList, SkeletonRows, useLoadState } from '../ui/LoadStates.tsx'
import { Checkbox, Switch } from '../ui/controls.tsx'
import { Dialog, Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { DangerConfirmDialog } from '../ui/DangerConfirmDialog.tsx'
import { List, ListEmpty, ListRow, MenuButton } from '../ui/list.tsx'
import { Field, Section, SwitchRow } from './fields.tsx'
import { callAction, readAction, useWriteAction } from './settings-api.ts'
import { lookupTestText, WebhookLookups } from './WebhookLookups.tsx'
import './webhooks.css'
import { brandName } from '../brand.ts'
import { fmt } from '../i18n/format.ts'

/** Each hook's name (the switch, the Send checkbox) and its test item in the row's menu. */
const HOOK_LABEL: Record<WebhookHook, MessageKey> = {
  call_start: msg('settings.webhooks.hook.callStart'),
  during_call: msg('settings.webhooks.hook.duringCall'),
  call_end: msg('settings.webhooks.hook.callEnd'),
}
const HOOK_TEST: Record<WebhookHook, MessageKey> = {
  call_start: msg('settings.webhooks.test.callStart'),
  during_call: msg('settings.webhooks.test.duringCall'),
  call_end: msg('settings.webhooks.test.callEnd'),
}
/** What a hook's switch says it sends; JSON and the greeting's {{name}} come in as arguments. */
function hookHelp(t: ReturnType<typeof useT>, hook: WebhookHook): string {
  if (hook === 'call_start')
    return t('settings.webhooks.hookHelp.callStart', {
      brand: brandName(),
      seconds: CALL_START_TIMEOUT_MS / 1000,
      json: '{"name": "Sam"}',
      placeholder: '{{name}}',
    })
  if (hook === 'during_call')
    return t('settings.webhooks.hookHelp.duringCall', {
      seconds: DURING_CALL_TIMEOUT_MS / 1000,
      json: '{"answer": "Order 1234 shipped Monday."}',
    })
  return t('settings.webhooks.hookHelp.callEnd', { seconds: CALL_END_DELAY_SEC })
}
/** The Request column of the log, by the delivery's event. */
const SENT_LABEL: Record<string, MessageKey> = {
  call_start: msg('settings.webhooks.log.callStart'),
  during_call: msg('settings.webhooks.log.duringCall'),
  call_end: msg('settings.webhooks.log.callEnd'),
  'webhook.test': msg('settings.webhooks.log.test'),
}

type Props = { assistantId: string; canEdit: boolean; toast: (text: string) => void }

export function Webhooks({ assistantId, canEdit, toast }: Props) {
  const t = useT()
  const endpoint = useRows('webhook_endpoints').find(e => e.assistant_id === assistantId) ?? null
  const load = useLoadState('webhook_endpoints')
  const [editing, setEditing] = useState(false)
  if (!canEdit)
    return (
      <Section id="as-webhooks" title={t('settings.webhooks.title')}>
        <p className="help">{t('settings.webhooks.onlyAdmins')}</p>
      </Section>
    )
  return (
    <Section
      id="as-webhooks"
      title={t('settings.webhooks.title')}
      help={t('settings.webhooks.help', { field: '"hook"', header: 'Linedesk-Hook', brand: brandName() })}
      actions={
        !endpoint &&
        load === 'ready' && (
          <Button size="sm" icon="plus" onClick={() => setEditing(true)}>
            {t('settings.webhooks.add')}
          </Button>
        )
      }
    >
      <Loading
        what={t('settings.webhooks.loading')}
        loading={load !== 'ready' && !endpoint}
        error={load === 'slow'}
        skeleton={<SkeletonList rows={1} aside action />}
      >
        {endpoint ? (
          <>
            <List label={t('settings.webhooks.title')}>
              <EndpointRow endpoint={endpoint} onEdit={() => setEditing(true)} toast={toast} />
            </List>
            <HookSwitches endpoint={endpoint} toast={toast} />
          </>
        ) : (
          <ListEmpty>{t('settings.webhooks.empty')}</ListEmpty>
        )}
      </Loading>
      {editing && (
        <EndpointDialog assistantId={assistantId} endpoint={endpoint} onClose={() => setEditing(false)} toast={toast} />
      )}
    </Section>
  )
}

/** One switch per hook: which requests the webhook gets. Under During the call, while it is on, its lookups. */
function HookSwitches({ endpoint, toast }: { endpoint: WebhookEndpoint; toast: Props['toast'] }) {
  const t = useT()
  const run = useRun()
  const set = (hook: WebhookHook, on: boolean) =>
    void run('webhook.update', {
      endpointId: endpoint.id,
      hooks: webhookHooks.filter(h => (h === hook ? on : endpoint.hooks.includes(h))),
    })
  return (
    <div className="wh-hooks">
      {webhookHooks.map(hook => (
        <Fragment key={hook}>
          <SwitchRow
            title={t(HOOK_LABEL[hook])}
            description={hookHelp(t, hook)}
            on={endpoint.hooks.includes(hook)}
            onChange={on => set(hook, on)}
          />
          {hook === 'during_call' && endpoint.hooks.includes(hook) && (
            <WebhookLookups endpoint={endpoint} toast={toast} />
          )}
        </Fragment>
      ))}
    </div>
  )
}

function StatusBadge({ endpoint }: { endpoint: WebhookEndpoint }) {
  const t = useT()
  if (endpoint.status === 'active')
    return (
      <Badge tone="ok">
        <StatusMark state="works" label={t('settings.webhooks.status.on')} />
        {t('settings.webhooks.status.on')}
      </Badge>
    )
  return endpoint.disabled_reason ? (
    <Badge tone="danger" title={endpoint.disabled_reason}>
      <StatusMark
        state="failing"
        label={t('settings.webhooks.status.switchedOffBecause', { reason: endpoint.disabled_reason })}
      />
      {t('settings.webhooks.status.switchedOff')}
    </Badge>
  ) : (
    <Badge>
      <StatusMark state="off" />
      {t('settings.webhooks.status.off')}
    </Badge>
  )
}

/** "name: Sam, plan: Premium", for the toast after a test send. */
const detailsText = (details: CallerDetails | null | undefined) =>
  details
    ? Object.entries(details)
        .map(([name, value]) => `${name}: ${String(value)}`)
        .join(', ')
    : null

function EndpointRow({
  endpoint,
  onEdit,
  toast,
}: {
  endpoint: WebhookEndpoint
  onEdit: () => void
  toast: Props['toast']
}) {
  const t = useT()
  const run = useRun()
  const write = useWriteAction()
  const [busy, setBusy] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [logVersion, setLogVersion] = useState(0)

  async function sendTest(hook: WebhookHook) {
    setBusy(true)
    try {
      const result = await callAction<WebhookTestData>('webhook.test', { endpointId: endpoint.id, hook })
      if (!result.ok) toast(t('settings.webhooks.testResult.failed', { error: result.error }))
      else if (hook === 'call_start') {
        const details = detailsText(result.details)
        toast(
          details
            ? t('settings.webhooks.testResult.details', { status: result.responseStatus, details })
            : t('settings.webhooks.testResult.noDetails', { status: result.responseStatus }),
        )
      } else if (hook === 'during_call') toast(lookupTestText(result))
      else toast(t('settings.webhooks.testResult.delivered', { status: result.responseStatus }))
      setLogVersion(v => v + 1)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // Errors show in the dialog (DangerConfirmDialog); it stays busy until the row is gone.
  async function remove() {
    await write('webhook.delete', { endpointId: endpoint.id })
    toast(t('settings.webhooks.deleted'))
  }

  return (
    <ListRow
      title={<span title={endpoint.url}>{endpoint.url}</span>}
      sub={endpoint.disabled_reason && <span className="wh-reason">{endpoint.disabled_reason}</span>}
      aside={<StatusBadge endpoint={endpoint} />}
      actions={
        <>
          <Switch
            label={t('settings.webhooks.sendTo', { url: endpoint.url })}
            on={endpoint.status === 'active'}
            onChange={on => void run('webhook.update', { endpointId: endpoint.id, enabled: on })}
          />
          <MenuButton
            title={t('settings.webhooks.actionsFor', { url: endpoint.url })}
            disabled={busy}
            items={[
              ...webhookHooks.map(hook => ({
                id: `test-${hook}`,
                label: t(HOOK_TEST[hook]),
                title: t('settings.webhooks.test.tip'),
                onSelect: () => void sendTest(hook),
              })),
              {
                id: 'log',
                label: showLog ? t('settings.webhooks.log.hide') : t('settings.webhooks.log.show'),
                onSelect: () => setShowLog(s => !s),
              },
              { id: 'edit', label: t('settings.webhooks.editAddress'), onSelect: onEdit },
              { id: 'delete', label: t('common.action.delete'), danger: true, onSelect: () => setConfirmDelete(true) },
            ]}
          />
          {confirmDelete && (
            <DangerConfirmDialog
              confirm={{
                action: t('settings.webhooks.delete.action'),
                busyAction: t('settings.webhooks.delete.busy'),
                text: t('settings.webhooks.delete.text', { url: endpoint.url }),
              }}
              run={remove}
              onClose={() => setConfirmDelete(false)}
            />
          )}
        </>
      }
      below={showLog && <DeliveryLog endpointId={endpoint.id} version={logVersion} />}
    />
  )
}

/** An address as the placeholder shows it: a URL, the same in every language. */
const URL_EXAMPLE = 'https://example.com/linedesk'

/** The last loaded log per endpoint, so opening it again shows it at once while it refreshes. */
const logCache = new Map<string, WebhookDeliverySummary[]>()

function DeliveryLog({ endpointId, version }: { endpointId: string; version: number }) {
  const t = useT()
  const [rows, setRows] = useState(() => logCache.get(endpointId) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` reloads the log after a test send, `attempt` after Try again
  useEffect(() => {
    let live = true
    setError(null)
    readAction<WebhookDeliveriesData>('webhook.deliveries', { endpointId }).then(
      data => {
        logCache.set(endpointId, data.deliveries)
        if (live) setRows(data.deliveries)
      },
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [endpointId, version, attempt])
  return (
    <Loading
      what={t('settings.webhooks.log.loading')}
      loading={!rows}
      error={error}
      onRetry={() => setAttempt(a => a + 1)}
      skeleton={<SkeletonRows rows={3} columns={4} className="wh-log" />}
    >
      {rows && <DeliveryTable rows={rows} />}
    </Loading>
  )
}

function DeliveryTable({ rows }: { rows: WebhookDeliverySummary[] }) {
  const t = useT()
  if (!rows.length) return <p className="help wh-log">{t('settings.webhooks.log.empty')}</p>
  return (
    <table className="wh-log">
      <thead>
        <tr>
          <th>{t('settings.webhooks.log.request')}</th>
          <th>{t('settings.webhooks.log.result')}</th>
          <th>{t('settings.webhooks.log.tries')}</th>
          <th>{t('settings.webhooks.log.when')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(d => (
          <tr key={d.id}>
            <td>{SENT_LABEL[d.event] ? t(SENT_LABEL[d.event]!) : d.event}</td>
            <td>
              <DeliveryResult delivery={d} />
            </td>
            <td>{fmt().number(d.attempts)}</td>
            <td>
              {fmt().dateTime(new Date(d.last_attempt_at ?? d.created_at), {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DeliveryResult({ delivery }: { delivery: WebhookDeliverySummary }) {
  const t = useT()
  if (delivery.status === 'delivered')
    return <Badge tone="ok">{delivery.response_status ?? t('settings.webhooks.log.ok')}</Badge>
  if (delivery.status === 'pending')
    return (
      <Badge title={delivery.error ?? undefined}>
        {delivery.attempts ? t('settings.webhooks.log.retrying') : t('settings.webhooks.log.queued')}
      </Badge>
    )
  return (
    <Badge tone="danger" title={delivery.error ?? undefined}>
      {delivery.response_status ?? t('settings.webhooks.log.failed')}
    </Badge>
  )
}

/** Add the webhook (its address and hooks, then its secret, once) or change its address. */
function EndpointDialog({
  assistantId,
  endpoint,
  onClose,
  toast,
}: {
  assistantId: string
  endpoint: WebhookEndpoint | null
  onClose: () => void
  toast: Props['toast']
}) {
  const t = useT()
  const run = useRun()
  const write = useWriteAction()
  const [url, setUrl] = useState(endpoint?.url ?? '')
  // During the call needs lookups first: it is switched on once there are some.
  const [hooks, setHooks] = useState<WebhookHook[]>(['call_start', 'call_end'])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (endpoint) {
      void run('webhook.update', { endpointId: endpoint.id, url: url.trim() })
      return onClose()
    }
    setSaving(true)
    setError(null)
    const newSecret = newWebhookSecret()
    try {
      await write('webhook.create', {
        endpointId: `whe_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
        assistantId,
        url: url.trim(),
        hooks,
        secret: newSecret,
      })
      setSecret(newSecret)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (secret)
    return (
      <Dialog
        key="secret" // a new dialog, so focus moves into it (Esc, Tab)
        title={t('settings.webhooks.secret.title')}
        description={t('settings.webhooks.secret.description')}
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            {t('settings.webhooks.secret.done')}
          </Button>
        }
      >
        <div className="wh-secret">
          <Input
            readOnly
            value={secret}
            aria-label={t('settings.webhooks.secret.title')}
            onFocus={e => e.currentTarget.select()}
          />
          <Button
            onClick={() =>
              navigator.clipboard.writeText(secret).then(
                () => toast(t('settings.webhooks.secret.copied')),
                () => toast(t('settings.webhooks.secret.copyFailed')),
              )
            }
          >
            {t('common.copy.copy')}
          </Button>
        </div>
        <p className="help">{t('settings.webhooks.secret.verifies', { header: 'Linedesk-Signature' })}</p>
      </Dialog>
    )

  return (
    <Dialog
      title={endpoint ? t('settings.webhooks.dialog.editTitle') : t('settings.webhooks.add')}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t('common.action.cancel')}</Button>
          <Button busy={saving} type="submit" variant="primary" disabled={saving || !url.trim()}>
            {endpoint
              ? t('common.action.save')
              : saving
                ? t('settings.webhooks.dialog.adding')
                : t('settings.webhooks.dialog.add')}
          </Button>
        </>
      }
    >
      <Field id="wh-url" label={t('settings.webhooks.dialog.url')} error={error}>
        <Input
          id="wh-url"
          type="url"
          required
          placeholder={URL_EXAMPLE}
          value={url}
          invalid={Boolean(error)}
          onChange={e => setUrl(e.target.value)}
        />
      </Field>
      {!endpoint && (
        <Field label={t('settings.webhooks.dialog.send')}>
          <div className="wh-hook-picks">
            {webhookHooks.map(hook => (
              <Checkbox
                key={hook}
                checked={hooks.includes(hook)}
                onChange={on => setHooks(list => webhookHooks.filter(h => (h === hook ? on : list.includes(h))))}
              >
                {t(HOOK_LABEL[hook])}
              </Checkbox>
            ))}
          </div>
        </Field>
      )}
    </Dialog>
  )
}
