// Assistant settings, Webhooks: the assistant's webhook, one address with the hooks it gets switched on.
// When a call starts, Linedesk asks it about the caller; during the call, the assistant asks its lookups
// (WebhookLookups.tsx); after the call, it sends the whole call (docs/webhooks.md). The webhook comes from the local store (synced, no secret), so it is there at once.
// Adding it shows its signing secret once; the hook switches and on/off go through the outbox; add,
// test-send and delete need the server's answer.
import {
  CALL_END_DELAY_SEC,
  CALL_START_TIMEOUT_MS,
  DURING_CALL_TIMEOUT_MS,
  hookLabel,
  newWebhookSecret,
  type WebhookDeliveriesData,
  type WebhookDeliverySummary,
  type WebhookTestData,
  webhookHooks,
} from '@linedesk/actions'
import type { CallerDetails, WebhookEndpoint, WebhookHook } from '@linedesk/db/types'
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

const HOOK_HELP: Record<WebhookHook, string> = {
  call_start: `${brandName()} sends the caller's number and waits up to ${CALL_START_TIMEOUT_MS / 1000} second. Answer with JSON like {"name": "Sam"}: the assistant knows it, and the greeting can say {{name}}.`,
  during_call: `The assistant asks one of its lookups (below) with what the caller said, and waits up to ${DURING_CALL_TIMEOUT_MS / 1000} seconds. Answer with JSON like {"answer": "Order 1234 shipped Monday."}.`,
  call_end: `About ${CALL_END_DELAY_SEC} seconds after the call: number, summary, transcript, next steps, bookings, links to the call and the recording.`,
}
const SENT_LABEL: Record<string, string> = {
  call_start: 'Call start',
  during_call: 'During the call',
  call_end: 'After the call',
  'webhook.test': 'Test',
}
const HELP =
  'One address for this assistant. Each request says which hook it is (the "hook" field and the Linedesk-Hook header) and is signed with the secret. If an after-call request fails, Linedesk keeps trying for about an hour; after 5 failures in a row the webhook is switched off.'

type Props = { assistantId: string; canEdit: boolean; toast: (text: string) => void }

export function Webhooks({ assistantId, canEdit, toast }: Props) {
  const endpoint = useRows('webhook_endpoints').find(e => e.assistant_id === assistantId) ?? null
  const load = useLoadState('webhook_endpoints')
  const [editing, setEditing] = useState(false)
  if (!canEdit)
    return (
      <Section id="as-webhooks" title="Webhook">
        <p className="help">Only admins can manage webhooks.</p>
      </Section>
    )
  return (
    <Section
      id="as-webhooks"
      title="Webhook"
      help={HELP}
      actions={
        !endpoint &&
        load === 'ready' && (
          <Button size="sm" icon="plus" onClick={() => setEditing(true)}>
            Add webhook
          </Button>
        )
      }
    >
      <Loading
        what="The webhook"
        loading={load !== 'ready' && !endpoint}
        error={load === 'slow'}
        skeleton={<SkeletonList rows={1} aside action />}
      >
        {endpoint ? (
          <>
            <List label="Webhook">
              <EndpointRow endpoint={endpoint} onEdit={() => setEditing(true)} toast={toast} />
            </List>
            <HookSwitches endpoint={endpoint} toast={toast} />
          </>
        ) : (
          <ListEmpty>No webhook yet.</ListEmpty>
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
            title={hookLabel[hook]}
            description={HOOK_HELP[hook]}
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
  if (endpoint.status === 'active')
    return (
      <Badge tone="ok">
        <StatusMark state="works" label="On" />
        On
      </Badge>
    )
  return endpoint.disabled_reason ? (
    <Badge tone="danger" title={endpoint.disabled_reason}>
      <StatusMark state="failing" label={`Switched off: ${endpoint.disabled_reason}`} />
      Switched off
    </Badge>
  ) : (
    <Badge>
      <StatusMark state="off" />
      Off
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
      if (!result.ok) toast(`Test failed: ${result.error}`)
      else if (hook === 'call_start') {
        const details = detailsText(result.details)
        toast(
          details
            ? `Answered ${result.responseStatus} with ${details}.`
            : `Answered ${result.responseStatus}, but with no caller details.`,
        )
      } else if (hook === 'during_call') toast(lookupTestText(result))
      else toast(`Test delivered (${result.responseStatus}).`)
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
    toast('Webhook deleted.')
  }

  return (
    <ListRow
      title={<span title={endpoint.url}>{endpoint.url}</span>}
      sub={endpoint.disabled_reason && <span className="wh-reason">{endpoint.disabled_reason}</span>}
      aside={<StatusBadge endpoint={endpoint} />}
      actions={
        <>
          <Switch
            label={`Send to ${endpoint.url}`}
            on={endpoint.status === 'active'}
            onChange={on => void run('webhook.update', { endpointId: endpoint.id, enabled: on })}
          />
          <MenuButton
            title={`Actions for ${endpoint.url}`}
            disabled={busy}
            items={[
              ...webhookHooks.map(hook => ({
                id: `test-${hook}`,
                label: `Test: ${hookLabel[hook].toLowerCase()}`,
                title: 'Send a signed example request now',
                onSelect: () => void sendTest(hook),
              })),
              { id: 'log', label: showLog ? 'Hide log' : 'Log', onSelect: () => setShowLog(s => !s) },
              { id: 'edit', label: 'Edit address', onSelect: onEdit },
              { id: 'delete', label: 'Delete', danger: true, onSelect: () => setConfirmDelete(true) },
            ]}
          />
          {confirmDelete && (
            <DangerConfirmDialog
              confirm={{
                action: 'Delete webhook',
                busyAction: 'Deleting…',
                text: `Nothing more is sent to ${endpoint.url}, and its log is deleted.`,
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

/** The last loaded log per endpoint, so opening it again shows it at once while it refreshes. */
const logCache = new Map<string, WebhookDeliverySummary[]>()

function DeliveryLog({ endpointId, version }: { endpointId: string; version: number }) {
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
      what="Deliveries"
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
  if (!rows.length) return <p className="help wh-log">No deliveries yet.</p>
  return (
    <table className="wh-log">
      <thead>
        <tr>
          <th>Request</th>
          <th>Result</th>
          <th>Tries</th>
          <th>When</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(d => (
          <tr key={d.id}>
            <td>{SENT_LABEL[d.event] ?? d.event}</td>
            <td>
              <DeliveryResult delivery={d} />
            </td>
            <td>{d.attempts}</td>
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
  if (delivery.status === 'delivered') return <Badge tone="ok">{delivery.response_status ?? 'OK'}</Badge>
  if (delivery.status === 'pending')
    return <Badge title={delivery.error ?? undefined}>{delivery.attempts ? 'Retrying' : 'Queued'}</Badge>
  return (
    <Badge tone="danger" title={delivery.error ?? undefined}>
      {delivery.response_status ?? 'Failed'}
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
        title="Signing secret"
        description="Shown only once. Copy it now."
        onClose={onClose}
        footer={
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div className="wh-secret">
          <Input readOnly value={secret} aria-label="Signing secret" onFocus={e => e.currentTarget.select()} />
          <Button
            onClick={() =>
              navigator.clipboard.writeText(secret).then(
                () => toast('Secret copied.'),
                () => toast('Copy failed. Select the secret instead.'),
              )
            }
          >
            Copy
          </Button>
        </div>
        <p className="help">Verifies the Linedesk-Signature header.</p>
      </Dialog>
    )

  return (
    <Dialog
      title={endpoint ? 'Edit webhook address' : 'Add webhook'}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button busy={saving} type="submit" variant="primary" disabled={saving || !url.trim()}>
            {endpoint ? 'Save' : saving ? 'Adding…' : 'Add'}
          </Button>
        </>
      }
    >
      <Field id="wh-url" label="URL" error={error}>
        <Input
          id="wh-url"
          type="url"
          required
          placeholder="https://example.com/linedesk"
          value={url}
          invalid={Boolean(error)}
          onChange={e => setUrl(e.target.value)}
        />
      </Field>
      {!endpoint && (
        <Field label="Send">
          <div className="wh-hook-picks">
            {webhookHooks.map(hook => (
              <Checkbox
                key={hook}
                checked={hooks.includes(hook)}
                onChange={on => setHooks(list => webhookHooks.filter(h => (h === hook ? on : list.includes(h))))}
              >
                {hookLabel[hook]}
              </Checkbox>
            ))}
          </div>
        </Field>
      )}
    </Dialog>
  )
}
