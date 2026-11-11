// Settings, Webhooks: where the workspace's events are sent. Endpoints come from the local store
// (synced, no secret), so the list is there at once. Adding one shows its signing secret once;
// switching on and off goes through the outbox; add, test-send and delete need the server's answer.
import {
  newWebhookSecret,
  type WebhookDeliveriesData,
  type WebhookDeliverySummary,
  type WebhookTestData,
  webhookEvents,
} from '@linedesk/actions'
import type { WebhookEndpoint, WebhookEvent } from '@linedesk/db/types'
import { type FormEvent, useEffect, useState } from 'react'
import { useRows, useRun } from '../store.tsx'
import { SkeletonRows, useLoadState } from '../ui/LoadStates.tsx'
import { Checkbox, Switch } from '../ui/controls.tsx'
import { Dialog, Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { Field, Section } from './fields.tsx'
import { callAction, readAction, useWriteAction } from './settings-api.ts'
import './webhooks.css'

const EVENT_LABEL: Record<WebhookEvent, string> = {
  'call.completed': 'Call completed',
  'call.summary_ready': 'Summary ready',
  'booking.created': 'Appointment booked',
  'message.taken': 'Message taken',
}

type Props = { canEdit: boolean; toast: (text: string) => void }

export function Webhooks({ canEdit, toast }: Props) {
  const endpoints = useRows('webhook_endpoints').sort((a, b) => a.created_at.localeCompare(b.created_at))
  const load = useLoadState('webhook_endpoints')
  const [editing, setEditing] = useState<WebhookEndpoint | 'new' | null>(null)
  if (!canEdit)
    return (
      <Section id="st-webhooks" title="Webhooks">
        <p className="help">Only owners and admins can manage webhooks.</p>
      </Section>
    )
  return (
    <Section
      id="st-webhooks"
      title="Webhooks"
      help="Calls, messages and bookings, as signed POSTs. Failed deliveries are retried for about an hour; an endpoint that keeps failing is turned off."
      actions={
        <Button size="sm" icon="plus" onClick={() => setEditing('new')}>
          Add endpoint
        </Button>
      }
    >
      {load !== 'ready' && endpoints.length === 0 ? (
        <SkeletonRows label="Loading webhooks" rows={2} />
      ) : endpoints.length === 0 ? (
        <p className="help">No endpoints yet.</p>
      ) : (
        <ul className="wh-list">
          {endpoints.map(e => (
            <EndpointRow key={e.id} endpoint={e} onEdit={() => setEditing(e)} toast={toast} />
          ))}
        </ul>
      )}
      {editing && (
        <EndpointDialog endpoint={editing === 'new' ? null : editing} onClose={() => setEditing(null)} toast={toast} />
      )}
    </Section>
  )
}

function StatusBadge({ endpoint }: { endpoint: WebhookEndpoint }) {
  if (endpoint.status === 'active')
    return (
      <Badge tone="ok" dot>
        On
      </Badge>
    )
  return endpoint.disabled_reason ? (
    <Badge tone="danger" dot title={endpoint.disabled_reason}>
      Switched off
    </Badge>
  ) : (
    <Badge>Off</Badge>
  )
}

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
  const [logVersion, setLogVersion] = useState(0)

  async function sendTest() {
    setBusy(true)
    try {
      const result = await callAction<WebhookTestData>('webhook.test', { endpointId: endpoint.id })
      toast(result.ok ? `Test event delivered (${result.responseStatus}).` : `Test event failed: ${result.error}`)
      setLogVersion(v => v + 1)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (
      !window.confirm(`Delete the endpoint ${endpoint.url}? It gets no more events, and its delivery log is deleted.`)
    )
      return
    setBusy(true)
    try {
      await write('webhook.delete', { endpointId: endpoint.id })
      toast('Endpoint deleted.')
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <li className="wh-row">
      <div className="wh-head">
        <span className="wh-main">
          <b title={endpoint.url}>{endpoint.url}</b>
          <span className="wh-sub">{endpoint.events.map(e => EVENT_LABEL[e] ?? e).join(', ')}</span>
          {endpoint.disabled_reason && <span className="wh-sub wh-reason">{endpoint.disabled_reason}</span>}
        </span>
        <StatusBadge endpoint={endpoint} />
        <Switch
          label={`Send events to ${endpoint.url}`}
          on={endpoint.status === 'active'}
          onChange={on => void run('webhook.update', { endpointId: endpoint.id, enabled: on })}
        />
      </div>
      <div className="wh-actions">
        <Button size="sm" variant="ghost" disabled={busy} onClick={sendTest} title="Send a signed test event now">
          Send test
        </Button>
        <Button size="sm" variant="ghost" aria-expanded={showLog} onClick={() => setShowLog(s => !s)}>
          {showLog ? 'Hide deliveries' : 'Deliveries'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={remove}>
          Delete
        </Button>
      </div>
      {showLog && <DeliveryLog endpointId={endpoint.id} version={logVersion} />}
    </li>
  )
}

/** The last loaded log per endpoint, so opening it again shows it at once while it refreshes. */
const logCache = new Map<string, WebhookDeliverySummary[]>()

function DeliveryLog({ endpointId, version }: { endpointId: string; version: number }) {
  const [rows, setRows] = useState(() => logCache.get(endpointId) ?? null)
  const [error, setError] = useState<string | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` reloads the log after a test send
  useEffect(() => {
    let live = true
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
  }, [endpointId, version])
  if (error && !rows)
    return (
      <p className="help" role="alert">
        {error}
      </p>
    )
  if (!rows) return <SkeletonRows label="Loading deliveries" rows={3} className="wh-log" />
  if (!rows.length) return <p className="help wh-log">No deliveries yet.</p>
  return (
    <table className="wh-log">
      <thead>
        <tr>
          <th>Event</th>
          <th>Result</th>
          <th>Tries</th>
          <th>When</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(d => (
          <tr key={d.id}>
            <td>{EVENT_LABEL[d.event as WebhookEvent] ?? (d.event === 'webhook.test' ? 'Test' : d.event)}</td>
            <td>
              <DeliveryResult delivery={d} />
            </td>
            <td>{d.attempts}</td>
            <td>
              {new Date(d.last_attempt_at ?? d.created_at).toLocaleString(undefined, {
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

/** Add an endpoint (then its secret, once) or change one's URL and events. */
function EndpointDialog({
  endpoint,
  onClose,
  toast,
}: {
  endpoint: WebhookEndpoint | null
  onClose: () => void
  toast: Props['toast']
}) {
  const run = useRun()
  const write = useWriteAction()
  const [url, setUrl] = useState(endpoint?.url ?? '')
  const [events, setEvents] = useState<WebhookEvent[]>(endpoint?.events ?? [...webhookEvents])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)

  const toggle = (event: WebhookEvent, on: boolean) =>
    setEvents(list => (on ? [...list, event] : list.filter(e => e !== event)))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!events.length) return setError('Pick at least one event.')
    if (endpoint) {
      void run('webhook.update', { endpointId: endpoint.id, url: url.trim(), events })
      return onClose()
    }
    setSaving(true)
    setError(null)
    const newSecret = newWebhookSecret()
    try {
      await write('webhook.create', {
        endpointId: `whe_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`,
        url: url.trim(),
        events,
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
      title={endpoint ? 'Edit endpoint' : 'Add endpoint'}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving || !url.trim()}>
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
      <Field label="Events">
        <div className="wh-events">
          {webhookEvents.map(event => (
            <Checkbox key={event} checked={events.includes(event)} onChange={on => toggle(event, on)}>
              {EVENT_LABEL[event]}
            </Checkbox>
          ))}
        </div>
      </Field>
    </Dialog>
  )
}
