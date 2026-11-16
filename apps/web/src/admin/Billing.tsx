// Server admin › Billing (docs/billing.md §11, PR 13): the bills of this install with their ledger, payments and
// invoices; what waits for review; the Stripe event inbox; who may sign up on their own; and the install's billing
// rules. Every write asks why (kept in the audit log) and runs through runAdmin, so the server's passkey step-up asks
// for the admin's passkey first; the ones that reach Stripe send one request id per dialog (its idempotency key).
import type {
  AdminBillDetail,
  AdminBillRow,
  AdminBillStatus,
  AdminReviewRow,
  AdminStripeEvent,
  BillingEventFilter,
  BillingRulesData,
  SelfServeData,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import { refreshQuery, setQueryData, useQuery } from '../cachedQuery.ts'
import { fmt } from '../i18n/format.ts'
import { AppLink } from '../ui/AppLink.tsx'
import { type SelectOption, Select, Switch } from '../ui/controls.tsx'
import { Card, Dialog, FormField, FormMessage, Input, Textarea } from '../ui/form.tsx'
import { Badge, Button, Note } from '../ui/kit.tsx'
import { Loading, Skeleton, SkeletonRows } from '../ui/LoadStates.tsx'
import { ActionBar, type AdminAction } from './actions.tsx'
import { AdminList, type Column, type ListKeys } from './AdminList.tsx'
import { runAdmin } from './api.ts'
import {
  changedFields,
  newRequestId,
  parseCount,
  parseDollars,
  RULE_FIELDS,
  type RuleField,
  type RulesForm,
  reasonProblem,
  rulesForm,
  rulesFromForm,
  usdOfCents,
  usdOfMicros,
} from './billingModel.ts'
import { errorText, type Notify } from './notify.ts'
import { day, EMPTY, when } from './parts.tsx'
import { Fact } from './WorkspacesPage.tsx'

type Translate = ReturnType<typeof useT>

const BILLS = 'admin.billing.bills'
const REVIEW = 'admin.billing.review'
const RULES = 'admin.billing.rules'
const SELF_SERVE = 'admin.billing.selfServe'
const billKey = (id: string) => `admin.billing.bill.${id}`
const eventsKey = (filter: BillingEventFilter) => `admin.billing.events.${filter}`

const loadBills = async () => ((await runAdmin('billing.adminBills', {})) as { bills: AdminBillRow[] }).bills
const loadBill = (id: string) => async () =>
  (await runAdmin('billing.adminBill', { billingAccountId: id })) as unknown as AdminBillDetail
const loadReview = async () =>
  (await runAdmin('billing.adminReview', {})) as unknown as { held: AdminReviewRow[]; newTrials: AdminReviewRow[] }
const loadRules = async () => (await runAdmin('billingRules.get', {})) as unknown as BillingRulesData
const loadSelfServe = async () => (await runAdmin('signup.getSelfServe', {})) as unknown as SelfServeData
type EventsPage = { events: AdminStripeEvent[]; next: string | null }
const loadEvents = (filter: BillingEventFilter, before?: string) => async () =>
  (await runAdmin('billing.adminEvents', { filter, ...(before ? { before } : {}) })) as unknown as EventsPage

/** After a write: the bill, the list and the review read again, so the page shows what was just done. */
async function refreshBill(id: string) {
  await Promise.all([refreshQuery(billKey(id)), refreshQuery(BILLS), refreshQuery(REVIEW)])
}

const STATUS: Record<AdminBillStatus, MessageKey> = {
  pending_payment: msg('admin.bills.status.pendingPayment'),
  trialing: msg('admin.bills.status.trialing'),
  active: msg('admin.bills.status.active'),
  past_due: msg('admin.bills.status.pastDue'),
  suspended: msg('admin.bills.status.suspended'),
  canceled: msg('admin.bills.status.canceled'),
  comped: msg('admin.bills.status.comped'),
}

function StatusBadge({ status }: { status: AdminBillStatus }) {
  const t = useT()
  const tone = status === 'suspended' || status === 'past_due' ? 'danger' : status === 'active' ? 'ok' : 'neutral'
  return <Badge tone={tone}>{t(STATUS[status])}</Badge>
}

const ownerText = (t: Translate, owner: { email: string | null; name: string | null }) =>
  owner.email ?? owner.name ?? t('admin.bills.noOwner')

/** The title of `#admin/billing/<id>`: whose bill it is, from the bill or the list, whichever is here first. */
export function useBillTitle(id: string | null): string | null {
  const t = useT()
  const bill = useQuery(id ? billKey(id) : null, loadBill(id ?? '')).data
  const bills = useQuery(id ? BILLS : null, loadBills).data
  if (!id) return null
  const owner = bill?.owner ?? bills?.find(b => b.id === id)?.owner
  return owner ? t('admin.bills.detail.title', { owner: ownerText(t, owner) }) : t('admin.bills.detail.untitled')
}

type Props = {
  id: string | null
  onOpen: (id: string) => void
  notify: Notify
  keysRef: { current: ListKeys | null }
}

export function Billing({ id, onOpen, notify, keysRef }: Props) {
  if (id) return <BillDetail id={id} notify={notify} />
  return (
    <>
      <BillsList onOpen={onOpen} keysRef={keysRef} />
      <ReviewCard onOpen={onOpen} notify={notify} />
      <EventsCard notify={notify} />
      <SelfServeCard notify={notify} />
      <RulesCard notify={notify} />
    </>
  )
}

// ---- Bills ----

const billColumns = (t: Translate): Column<AdminBillRow>[] => [
  {
    key: 'owner',
    label: t('admin.bills.column.owner'),
    sort: b => ownerText(t, b.owner),
    render: b => (
      <span className="adm-strong">
        {ownerText(t, b.owner)}
        {b.kind === 'partner' && <Badge>{t('admin.bills.kind.partner')}</Badge>}
        {b.heldForReviewAt && <Badge tone="danger">{t('admin.bills.badge.held')}</Badge>}
        <span className="adm-sub">
          {b.workspaces.length
            ? fmt().list(
                b.workspaces.map(w => w.name),
                { type: 'unit', style: 'short' },
              )
            : t('admin.bills.noWorkspaces')}
        </span>
      </span>
    ),
  },
  {
    key: 'status',
    label: t('admin.bills.column.status'),
    sort: b => b.status,
    render: b => <StatusBadge status={b.status} />,
  },
  {
    key: 'balance',
    label: t('admin.bills.column.balance'),
    numeric: true,
    firstDir: 'asc',
    sort: b => b.balanceMicros,
    render: b => usdOfMicros(b.balanceMicros),
  },
  {
    key: 'created',
    label: t('admin.bills.column.created'),
    firstDir: 'desc',
    wide: true,
    sort: b => Date.parse(b.createdAt),
    render: b => day(b.createdAt),
  },
]

function BillsList({ onOpen, keysRef }: { onOpen: (id: string) => void; keysRef: { current: ListKeys | null } }) {
  const t = useT()
  const query = useQuery(BILLS, loadBills)
  const columns = useMemo(() => billColumns(t), [t])
  if (!query.data)
    return (
      <div className="adm-card adm-listcard">
        <Loading
          what={t('admin.bills.what')}
          loading
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<SkeletonRows rows={4} columns={4} className="adm-sk-rows" />}
        />
      </div>
    )
  return (
    <AdminList
      rows={query.data}
      rowId={b => b.id}
      columns={columns}
      initialSort={{ key: 'created', dir: 'desc' }}
      searchText={b =>
        `${b.owner.email ?? ''} ${b.owner.name ?? ''} ${b.workspaces.map(w => w.name).join(' ')} ${b.id}`
      }
      searchLabel={t('admin.bills.search')}
      label={t('admin.bills.what')}
      onOpen={b => onOpen(b.id)}
      keysRef={keysRef}
      empty={t('admin.bills.empty')}
    />
  )
}

// ---- Review ----

function ReviewCard({ onOpen, notify }: { onOpen: (id: string) => void; notify: Notify }) {
  const t = useT()
  const query = useQuery(REVIEW, loadReview)
  const [deciding, setDeciding] = useState<{ row: AdminReviewRow; decision: 'approve' | 'deny' } | null>(null)
  const rows = query.data ? [...query.data.held, ...query.data.newTrials] : []
  return (
    <Card
      title={t('admin.bills.review.title')}
      description={t('admin.bills.review.description')}
      className="adm-detail"
    >
      <Loading
        what={t('admin.bills.review.title')}
        loading={!query.data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonRows rows={2} columns={4} />}
      >
        {rows.length ? (
          <div className="adm-scroll">
            <table className="adm-table adm-stack">
              <thead>
                <tr>
                  <th scope="col">{t('admin.bills.column.owner')}</th>
                  <th scope="col">{t('admin.bills.column.status')}</th>
                  <th scope="col">{t('admin.bills.review.column.since')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('admin.bills.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.billId}>
                    <th scope="row" data-label={t('admin.bills.column.owner')}>
                      <AppLink to={`#admin/billing/${encodeURIComponent(row.billId)}`}>
                        {ownerText(t, row.owner)}
                      </AppLink>
                      <span className="adm-sub">{t('admin.bills.workspaceCount', { count: row.workspaces })}</span>
                    </th>
                    <td data-label={t('admin.bills.column.status')}>
                      {row.heldForReviewAt ? (
                        <Badge tone="danger">{t('admin.bills.badge.held')}</Badge>
                      ) : (
                        <StatusBadge status={row.status} />
                      )}
                    </td>
                    <td data-label={t('admin.bills.review.column.since')}>
                      {when(row.heldForReviewAt ?? row.createdAt)}
                    </td>
                    <td>
                      {row.heldForReviewAt ? (
                        <span className="adm-actbar">
                          <Button size="sm" onClick={() => setDeciding({ row, decision: 'approve' })}>
                            {t('admin.bills.review.approve')}
                          </Button>
                          <Button
                            size="sm"
                            variant="danger-outline"
                            onClick={() => setDeciding({ row, decision: 'deny' })}
                          >
                            {t('admin.bills.review.deny')}
                          </Button>
                        </span>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => onOpen(row.billId)}>
                          {t('admin.bills.open')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="adm-notice">{t('admin.bills.review.empty')}</p>
        )}
        {/* The sign-up checks (docs/billing.md §5) do not record Radar's risk or the card's details here yet. */}
        <Note tone="info">{t('admin.bills.review.radarPending')}</Note>
      </Loading>
      {deciding && (
        <ReasonDialog
          title={t(
            deciding.decision === 'approve' ? 'admin.bills.review.approveTitle' : 'admin.bills.review.denyTitle',
            {
              owner: ownerText(t, deciding.row.owner),
            },
          )}
          description={t(
            deciding.decision === 'approve' ? 'admin.bills.review.approveText' : 'admin.bills.review.denyText',
          )}
          submit={t(deciding.decision === 'approve' ? 'admin.bills.review.approve' : 'admin.bills.review.deny')}
          danger={deciding.decision === 'deny'}
          run={async reason => {
            await runAdmin('billing.reviewHold', {
              billingAccountId: deciding.row.billId,
              decision: deciding.decision,
              reason,
            })
            await refreshBill(deciding.row.billId)
            return t(deciding.decision === 'approve' ? 'admin.bills.review.approved' : 'admin.bills.review.denied')
          }}
          notify={notify}
          onClose={() => setDeciding(null)}
        />
      )}
    </Card>
  )
}

// ---- Stripe events ----

const EVENT_STATE: Record<AdminStripeEvent['state'], MessageKey> = {
  processed: msg('admin.bills.events.state.processed'),
  waiting: msg('admin.bills.events.state.waiting'),
  failed: msg('admin.bills.events.state.failed'),
  unhandled: msg('admin.bills.events.state.unhandled'),
}
const FILTERS: Record<BillingEventFilter, MessageKey> = {
  all: msg('admin.bills.events.filter.all'),
  waiting: msg('admin.bills.events.filter.waiting'),
  failed: msg('admin.bills.events.filter.failed'),
  unhandled: msg('admin.bills.events.filter.unhandled'),
}

function EventsCard({ notify }: { notify: Notify }) {
  const t = useT()
  const [filter, setFilter] = useState<BillingEventFilter>('all')
  const query = useQuery(eventsKey(filter), loadEvents(filter))
  const [older, setOlder] = useState<EventsPage | null>(null)
  const [reprocessing, setReprocessing] = useState<AdminStripeEvent | null>(null)
  const events = [...(query.data?.events ?? []), ...(older?.events ?? [])]
  const next = older ? older.next : (query.data?.next ?? null)
  const options: SelectOption<BillingEventFilter>[] = (Object.keys(FILTERS) as BillingEventFilter[]).map(value => ({
    value,
    label: t(FILTERS[value]),
  }))

  async function more() {
    if (!next) return
    try {
      const page = await loadEvents(filter, next)()
      setOlder(previous => ({ events: [...(previous?.events ?? []), ...page.events], next: page.next }))
    } catch (err) {
      notify(errorText(err))
    }
  }
  // Like every billing write, processing an event again asks why (the reason is kept in the audit log).
  async function reprocess(event: AdminStripeEvent, reason: string) {
    await runAdmin('billing.reprocessEvent', { eventId: event.id, reason })
    setOlder(null)
    await refreshQuery(eventsKey(filter))
    return t('admin.bills.events.queued', { type: event.type })
  }

  return (
    <Card
      title={t('admin.bills.events.title')}
      description={t('admin.bills.events.description')}
      actions={
        <Select
          value={filter}
          options={options}
          onChange={value => {
            setOlder(null)
            setFilter(value)
          }}
          label={t('admin.bills.events.filter.label')}
          size="sm"
          align="end"
        />
      }
      className="adm-detail"
    >
      <Loading
        what={t('admin.bills.events.title')}
        loading={!query.data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonRows rows={4} columns={4} />}
      >
        {events.length ? (
          <div className="adm-scroll">
            <table className="adm-table adm-stack">
              <thead>
                <tr>
                  <th scope="col">{t('admin.bills.events.column.event')}</th>
                  <th scope="col">{t('admin.bills.events.column.state')}</th>
                  <th scope="col">{t('admin.bills.events.column.received')}</th>
                  <th scope="col" className="adm-num">
                    {t('admin.bills.events.column.attempts')}
                  </th>
                  <th scope="col">
                    <span className="sr-only">{t('admin.bills.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map(e => (
                  <tr key={e.id}>
                    <th scope="row" data-label={t('admin.bills.events.column.event')}>
                      <span className="adm-mono">{e.type}</span>
                      <span className="adm-sub adm-mono">
                        {e.id}
                        {!e.livemode && ` · ${t('admin.bills.events.test')}`}
                      </span>
                      {e.billId && (
                        <span className="adm-sub">
                          <AppLink to={`#admin/billing/${encodeURIComponent(e.billId)}`}>
                            {t('admin.bills.events.openBill')}
                          </AppLink>
                        </span>
                      )}
                      {e.lastError && e.state !== 'processed' && <span className="adm-sub">{e.lastError}</span>}
                    </th>
                    <td data-label={t('admin.bills.events.column.state')}>
                      <Badge tone={e.state === 'failed' ? 'danger' : e.state === 'processed' ? 'ok' : 'neutral'}>
                        {t(EVENT_STATE[e.state])}
                      </Badge>
                    </td>
                    <td data-label={t('admin.bills.events.column.received')}>{when(e.receivedAt)}</td>
                    <td className="adm-num" data-label={t('admin.bills.events.column.attempts')}>
                      {fmt().number(e.attempts)}
                    </td>
                    <td>
                      {e.state !== 'processed' && (
                        <Button
                          size="sm"
                          icon="restart"
                          title={t('admin.bills.events.reprocessTip')}
                          onClick={() => setReprocessing(e)}
                        >
                          {t('admin.bills.events.reprocess')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="adm-notice">{t('admin.bills.events.empty')}</p>
        )}
        {next && (
          <div>
            <Button size="sm" variant="ghost" onClick={() => void more()}>
              {t('admin.bills.events.older')}
            </Button>
          </div>
        )}
      </Loading>
      {reprocessing && (
        <ReasonDialog
          title={t('admin.bills.events.reprocessTitle', { type: reprocessing.type })}
          description={t('admin.bills.events.reprocessText')}
          submit={t('admin.bills.events.reprocess')}
          run={reason => reprocess(reprocessing, reason)}
          notify={notify}
          onClose={() => setReprocessing(null)}
        />
      )}
    </Card>
  )
}

// ---- Self-serve sign-up ----

function SelfServeCard({ notify }: { notify: Notify }) {
  const t = useT()
  const query = useQuery(SELF_SERVE, loadSelfServe)
  const [asking, setAsking] = useState<boolean | null>(null)
  const data = query.data
  return (
    <Card title={t('admin.bills.selfServe.title')} className="adm-detail">
      <div className="swrow">
        <div>
          <b>{t('admin.bills.selfServe.switch')}</b>
          <span className="help">
            {data && !data.billingInEffect && !data.on
              ? t('admin.bills.selfServe.needsBilling')
              : t('admin.bills.selfServe.help')}
          </span>
        </div>
        <Loading
          what={t('admin.bills.selfServe.switch')}
          loading={!data}
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<Skeleton width={34} height={20} className="sk-round" />}
        >
          <Switch
            on={data?.on ?? false}
            onChange={setAsking}
            label={t('admin.bills.selfServe.switch')}
            // Off always works; on needs billing through Stripe in effect.
            disabled={!data || (!data.on && !data.billingInEffect)}
          />
        </Loading>
      </div>
      {asking !== null && (
        <ReasonDialog
          title={t(asking ? 'admin.bills.selfServe.onTitle' : 'admin.bills.selfServe.offTitle')}
          description={t(asking ? 'admin.bills.selfServe.onText' : 'admin.bills.selfServe.offText')}
          submit={t(asking ? 'admin.bills.selfServe.on' : 'admin.bills.selfServe.off')}
          run={async reason => {
            const saved = (await runAdmin('signup.setSelfServe', { on: asking, reason })) as unknown as SelfServeData
            setQueryData<SelfServeData | undefined>(SELF_SERVE, saved)
            return t(saved.on ? 'admin.bills.selfServe.turnedOn' : 'admin.bills.selfServe.turnedOff')
          }}
          notify={notify}
          onClose={() => setAsking(null)}
        />
      )}
    </Card>
  )
}

// ---- Billing rules ----

const RULE_LABELS: Record<RuleField, MessageKey> = {
  includedStandardSeconds: msg('admin.bills.rules.field.includedStandardSeconds'),
  balanceBufferMicros: msg('admin.bills.rules.field.balanceBufferMicros'),
  trialConcurrentCalls: msg('admin.bills.rules.field.trialConcurrentCalls'),
  concurrentCallsBase: msg('admin.bills.rules.field.concurrentCallsBase'),
  concurrentCallsPerWorkspace: msg('admin.bills.rules.field.concurrentCallsPerWorkspace'),
  billedTransferCapSeconds: msg('admin.bills.rules.field.billedTransferCapSeconds'),
  callLimitGraceSeconds: msg('admin.bills.rules.field.callLimitGraceSeconds'),
  extraNumberCents: msg('admin.bills.rules.field.extraNumberCents'),
  rechargeCapPerWorkspaceCents: msg('admin.bills.rules.field.rechargeCapPerWorkspaceCents'),
}

function RulesCard({ notify }: { notify: Notify }) {
  const t = useT()
  const query = useQuery(RULES, loadRules)
  const data = query.data
  const saved = useMemo(() => (data ? rulesForm(data.effective) : null), [data])
  const defaults = useMemo(() => (data ? rulesForm(data.defaults) : null), [data])
  const [form, setForm] = useState<RulesForm>({})
  const [problems, setProblems] = useState<string[]>([])
  const [asking, setAsking] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    if (saved) setForm(saved)
  }, [saved])
  const dirty = !!saved && changedFields(form, saved).length > 0

  function save(e: FormEvent) {
    e.preventDefault()
    if (!data) return
    const parsed = rulesFromForm(form, data.defaults)
    setProblems(parsed.problems)
    if ('rules' in parsed) setAsking(parsed.rules)
  }
  const field = (key: string, label: string, aside?: string) => (
    <FormField
      key={key}
      id={`adm-rule-${key}`}
      label={label}
      aside={defaults && t('admin.bills.rules.default', { value: defaults[key] || EMPTY })}
      description={aside}
      error={problems.includes(key) ? t('admin.bills.rules.notANumber') : null}
    >
      <Input
        id={`adm-rule-${key}`}
        inputMode="decimal"
        size="sm"
        value={form[key] ?? ''}
        invalid={problems.includes(key)}
        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
      />
    </FormField>
  )
  return (
    <Card title={t('admin.bills.rules.title')} description={t('admin.bills.rules.description')} className="adm-detail">
      <Loading
        what={t('admin.bills.rules.title')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonRows rows={4} columns={2} />}
      >
        {data && (
          <form onSubmit={save} className="adm-rules">
            {data.problems.length > 0 && (
              <Note tone="warning">{t('admin.bills.rules.ignored', { fields: data.problems.join(', ') })}</Note>
            )}
            {Object.keys(data.defaults.levels).map(level => (
              <div key={level} className="adm-rules-row">
                {field(
                  `levels.${level}.price`,
                  t('admin.bills.rules.levelPrice', { level }),
                  data.minMicrosPerMinute > 0
                    ? t('admin.bills.rules.minPrice', { amount: usdOfMicros(data.minMicrosPerMinute) })
                    : undefined,
                )}
                {field(`levels.${level}.factor`, t('admin.bills.rules.levelFactor', { level }))}
              </div>
            ))}
            {RULE_FIELDS.map(([key]) => field(key, t(RULE_LABELS[key])))}
            <div className="adm-actbar">
              <Button type="submit" variant="primary" disabled={!dirty}>
                {t('admin.bills.rules.save')}
              </Button>
              <Button disabled={!dirty} onClick={() => saved && setForm(saved)}>
                {t('common.action.cancel')}
              </Button>
            </div>
          </form>
        )}
      </Loading>
      {asking && (
        <ReasonDialog
          title={t('admin.bills.rules.confirmTitle')}
          description={t('admin.bills.rules.confirmText')}
          submit={t('admin.bills.rules.save')}
          run={async reason => {
            const next = (await runAdmin('billingRules.set', { rules: asking, reason })) as unknown as BillingRulesData
            setQueryData<BillingRulesData | undefined>(RULES, next)
            return t('admin.bills.rules.saved')
          }}
          notify={notify}
          onClose={() => setAsking(null)}
        />
      )}
    </Card>
  )
}

// ---- One bill ----

type Open =
  | { kind: 'credit'; rechargeId?: string; amountCents?: number }
  | { kind: 'refund' }
  | { kind: 'status'; status: 'comped' | 'suspended' | 'active' }
  | { kind: 'cap' }
  | { kind: 'concurrency' }
  | { kind: 'owner' }
  | { kind: 'move' }

const LEDGER_KIND: Record<AdminBillDetail['ledger'][number]['kind'], MessageKey> = {
  usage: msg('admin.bills.ledger.kind.usage'),
  number: msg('admin.bills.ledger.kind.number'),
  recharge: msg('admin.bills.ledger.kind.recharge'),
  topup: msg('admin.bills.ledger.kind.topup'),
  refund: msg('admin.bills.ledger.kind.refund'),
  credit: msg('admin.bills.ledger.kind.credit'),
  adjustment: msg('admin.bills.ledger.kind.adjustment'),
  writeoff: msg('admin.bills.ledger.kind.writeoff'),
}

function BillDetail({ id, notify }: { id: string; notify: Notify }) {
  const t = useT()
  const query = useQuery(billKey(id), loadBill(id))
  const [open, setOpen] = useState<Open | null>(null)
  const bill = query.data
  if (!bill)
    return (
      <div className="adm-card">
        <Loading
          what={t('admin.bills.detail.what')}
          loading
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<SkeletonRows rows={6} columns={2} />}
        />
      </div>
    )
  const canceled = bill.status === 'canceled'
  const actions: AdminAction[] = [
    {
      id: 'credit',
      label: t('admin.bills.action.credit'),
      icon: 'plus',
      tip: t('admin.bills.action.creditTip'),
      run: async () => setOpen({ kind: 'credit' }),
    },
    {
      id: 'refund',
      label: t('admin.bills.action.refund'),
      icon: 'reply',
      tip: t('admin.bills.action.refundTip'),
      disabledReason: !bill.dashboardUrl
        ? t('admin.bills.action.needsStripe')
        : !bill.refundable.some(p => p.creditedMicros > p.refundedMicros)
          ? t('admin.bills.action.nothingToRefund')
          : undefined,
      run: async () => setOpen({ kind: 'refund' }),
    },
    ...(bill.status === 'comped' || bill.status === 'suspended'
      ? [
          {
            id: 'resume',
            label: t('admin.bills.action.resume'),
            icon: 'restart' as const,
            tip: t('admin.bills.action.resumeTip'),
            run: async () => setOpen({ kind: 'status', status: 'active' }),
          },
        ]
      : []),
    ...(!canceled && bill.status !== 'comped'
      ? [
          {
            id: 'comp',
            label: t('admin.bills.action.comp'),
            icon: 'star' as const,
            tip: t('admin.bills.action.compTip'),
            run: async () => setOpen({ kind: 'status', status: 'comped' }),
          },
        ]
      : []),
    ...(!canceled && bill.status !== 'suspended'
      ? [
          {
            id: 'suspend',
            label: t('admin.bills.action.suspend'),
            icon: 'ban' as const,
            tip: t('admin.bills.action.suspendTip'),
            danger: true,
            run: async () => setOpen({ kind: 'status', status: 'suspended' }),
          },
        ]
      : []),
    {
      id: 'cap',
      label: t('admin.bills.action.cap'),
      icon: 'pencil',
      tip: t('admin.bills.action.capTip'),
      run: async () => setOpen({ kind: 'cap' }),
    },
    {
      id: 'concurrency',
      label: t('admin.bills.action.concurrency'),
      icon: 'phone',
      tip: t('admin.bills.action.concurrencyTip'),
      run: async () => setOpen({ kind: 'concurrency' }),
    },
    {
      id: 'owner',
      label: t('admin.bills.action.owner'),
      icon: 'user',
      tip: t('admin.bills.action.ownerTip'),
      disabledReason: bill.members.length < 2 ? t('admin.bills.action.noOtherMember') : undefined,
      run: async () => setOpen({ kind: 'owner' }),
    },
    {
      id: 'move',
      label: t('admin.bills.action.move'),
      icon: 'move',
      tip: t('admin.bills.action.moveTip'),
      disabledReason: !bill.workspaces.length
        ? t('admin.bills.noWorkspaces')
        : !bill.otherBills.some(b => b.status !== 'canceled')
          ? t('admin.bills.action.noOtherBill')
          : undefined,
      run: async () => setOpen({ kind: 'move' }),
    },
  ]
  const stripe = (path: string) => (bill.dashboardUrl ? `${bill.dashboardUrl}/${path}` : null)
  const done = async (text: string) => {
    await refreshBill(id)
    return text
  }

  return (
    <>
      <ActionBar
        actions={actions}
        onPick={a => {
          void a.run()
        }}
      />
      <Card title={t('admin.bills.detail.facts')} className="adm-detail">
        <dl className="adm-facts">
          <Fact label={t('admin.bills.column.status')}>
            <StatusBadge status={bill.status} />
            {bill.suspendReason && (
              <span className="adm-sub">{t('admin.bills.suspendReason', { reason: bill.suspendReason })}</span>
            )}
            {bill.heldForReviewAt && (
              <span className="adm-sub">{t('admin.bills.heldSince', { when: when(bill.heldForReviewAt) })}</span>
            )}
          </Fact>
          <Fact label={t('admin.bills.fact.plan')}>
            {t(bill.kind === 'partner' ? 'admin.bills.kind.partner' : 'admin.bills.kind.cloud')}
            {' · '}
            {t(bill.interval === 'year' ? 'admin.bills.interval.year' : 'admin.bills.interval.month')}
          </Fact>
          <Fact label={t('admin.bills.column.owner')}>
            <AppLink to={`#admin/users/${encodeURIComponent(bill.owner.id)}`}>{ownerText(t, bill.owner)}</AppLink>
          </Fact>
          <Fact label={t('admin.bills.column.balance')}>
            {usdOfMicros(bill.balanceMicros)}
            {bill.reservedMicros > 0 && (
              <span className="adm-sub">{t('admin.bills.reserved', { amount: usdOfMicros(bill.reservedMicros) })}</span>
            )}
          </Fact>
          <Fact label={t('admin.bills.fact.period')}>
            {bill.currentPeriodStart && bill.currentPeriodEnd
              ? t('admin.bills.fact.periodRange', {
                  from: day(bill.currentPeriodStart),
                  to: day(bill.currentPeriodEnd),
                })
              : EMPTY}
            {bill.trialEndsAt && (
              <span className="adm-sub">{t('admin.bills.fact.trialEnds', { when: day(bill.trialEndsAt) })}</span>
            )}
          </Fact>
          <Fact label={t('admin.bills.fact.recharge')}>
            {bill.autoRecharge
              ? t('admin.bills.fact.rechargeOn', {
                  amount: usdOfCents(bill.rechargeAmountCents),
                  threshold: usdOfCents(bill.rechargeThresholdCents),
                })
              : t('admin.bills.fact.rechargeOff')}
            {bill.rechargeFailedAt && (
              <span className="adm-sub">
                {t('admin.bills.fact.rechargeFailed', { when: when(bill.rechargeFailedAt) })}
              </span>
            )}
          </Fact>
          <Fact label={t('admin.bills.fact.cap')}>
            {t('admin.bills.fact.capValue', {
              cap: usdOfCents(bill.rechargeCapCents),
              base: usdOfCents(bill.rechargeCapBaseCents),
            })}
          </Fact>
          <Fact label={t('admin.bills.fact.concurrency')}>
            {bill.concurrentCallsCap === null
              ? t('admin.bills.fact.concurrencyRules', { count: bill.rulesConcurrentCalls })
              : t('admin.bills.fact.concurrencySet', { count: bill.concurrentCallsCap })}
          </Fact>
          <Fact label={t('admin.bills.fact.stripe')}>
            {bill.stripeCustomerId && stripe(`customers/${bill.stripeCustomerId}`) ? (
              <span className="adm-line">
                <a href={stripe(`customers/${bill.stripeCustomerId}`)!} target="_blank" rel="noreferrer">
                  {t('admin.bills.fact.customer')}
                </a>
                {bill.stripeSubscriptionId && (
                  <>
                    {' · '}
                    <a href={stripe(`subscriptions/${bill.stripeSubscriptionId}`)!} target="_blank" rel="noreferrer">
                      {t('admin.bills.fact.subscription')}
                    </a>
                  </>
                )}
              </span>
            ) : (
              t('admin.bills.fact.noStripe')
            )}
          </Fact>
          <Fact label={t('admin.bills.column.created')}>{day(bill.createdAt)}</Fact>
        </dl>
      </Card>

      <Card
        title={t('admin.bills.usage.title')}
        description={t('admin.bills.usage.description')}
        className="adm-detail"
      >
        {bill.workspaces.length ? (
          <div className="adm-scroll">
            <table className="adm-table adm-stack">
              <thead>
                <tr>
                  <th scope="col">{t('admin.bills.usage.workspace')}</th>
                  <th scope="col" className="adm-num">
                    {t('admin.bills.usage.minutes')}
                  </th>
                  <th scope="col" className="adm-num">
                    {t('admin.bills.usage.paid')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {bill.workspaces.map(w => {
                  const used = bill.usage.find(u => u.workspaceId === w.id)
                  return (
                    <tr key={w.id}>
                      <th scope="row" data-label={t('admin.bills.usage.workspace')}>
                        <AppLink to={`#admin/workspaces/${encodeURIComponent(w.id)}`}>{w.name}</AppLink>
                      </th>
                      <td className="adm-num" data-label={t('admin.bills.usage.minutes')}>
                        {fmt().number((used?.seconds ?? 0) / 60, { maximumFractionDigits: 1 })}
                      </td>
                      <td className="adm-num" data-label={t('admin.bills.usage.paid')}>
                        {usdOfMicros(used?.paidMicros ?? 0)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="adm-notice">{t('admin.bills.noWorkspaces')}</p>
        )}
      </Card>

      <Card
        title={t('admin.bills.ledger.title')}
        description={t('admin.bills.ledger.description')}
        className="adm-detail"
      >
        {bill.ledger.length ? (
          <div className="adm-scroll">
            <table className="adm-table adm-stack">
              <thead>
                <tr>
                  <th scope="col">{t('admin.bills.ledger.column.when')}</th>
                  <th scope="col">{t('admin.bills.ledger.column.kind')}</th>
                  <th scope="col" className="adm-num">
                    {t('admin.bills.ledger.column.amount')}
                  </th>
                  <th scope="col">{t('admin.bills.ledger.column.note')}</th>
                </tr>
              </thead>
              <tbody>
                {bill.ledger.map(e => (
                  <tr key={e.id}>
                    <td data-label={t('admin.bills.ledger.column.when')}>{when(e.createdAt)}</td>
                    <th scope="row" data-label={t('admin.bills.ledger.column.kind')}>
                      {t(LEDGER_KIND[e.kind])}
                      {e.seconds !== null && (
                        <span className="adm-sub">
                          {t('admin.bills.ledger.seconds', { count: e.seconds, level: e.priceBasis ?? EMPTY })}
                        </span>
                      )}
                    </th>
                    <td className="adm-num" data-label={t('admin.bills.ledger.column.amount')}>
                      {usdOfMicros(e.amountMicros)}
                    </td>
                    <td data-label={t('admin.bills.ledger.column.note')}>
                      {e.note ?? EMPTY}
                      {e.actor && <span className="adm-sub">{e.actor.email ?? e.actor.id}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="adm-notice">{t('admin.bills.ledger.empty')}</p>
        )}
      </Card>

      <Card title={t('admin.bills.recharges.title')} className="adm-detail">
        {bill.recharges.length ? (
          <div className="adm-scroll">
            <table className="adm-table adm-stack">
              <thead>
                <tr>
                  <th scope="col">{t('admin.bills.ledger.column.when')}</th>
                  <th scope="col" className="adm-num">
                    {t('admin.bills.ledger.column.amount')}
                  </th>
                  <th scope="col">{t('admin.bills.column.status')}</th>
                  <th scope="col">
                    <span className="sr-only">{t('admin.bills.column.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {bill.recharges.map(r => (
                  <tr key={r.id}>
                    <td data-label={t('admin.bills.ledger.column.when')}>{when(r.createdAt)}</td>
                    <td className="adm-num" data-label={t('admin.bills.ledger.column.amount')}>
                      {usdOfCents(r.amountCents)}
                    </td>
                    <th scope="row" data-label={t('admin.bills.column.status')}>
                      {t(RECHARGE_STATUS[r.status])}
                      {r.failureCode && <span className="adm-sub adm-mono">{r.failureCode}</span>}
                      {r.invoiceId && stripe(`invoices/${r.invoiceId}`) && (
                        <span className="adm-sub">
                          <a href={stripe(`invoices/${r.invoiceId}`)!} target="_blank" rel="noreferrer">
                            {t('admin.bills.invoices.open')}
                          </a>
                        </span>
                      )}
                    </th>
                    <td>
                      {(r.status === 'failed' || r.status === 'pending') && (
                        <Button
                          size="sm"
                          title={t('admin.bills.recharges.creditTip')}
                          onClick={() => setOpen({ kind: 'credit', rechargeId: r.id, amountCents: r.amountCents })}
                        >
                          {t('admin.bills.recharges.credit')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="adm-notice">{t('admin.bills.recharges.empty')}</p>
        )}
      </Card>

      <Card title={t('admin.bills.invoices.title')} className="adm-detail">
        {bill.invoices.length ? (
          <div className="adm-scroll">
            <table className="adm-table adm-stack">
              <thead>
                <tr>
                  <th scope="col">{t('admin.bills.invoices.column.invoice')}</th>
                  <th scope="col">{t('admin.bills.column.status')}</th>
                  <th scope="col" className="adm-num">
                    {t('admin.bills.invoices.column.total')}
                  </th>
                  <th scope="col">{t('admin.bills.column.created')}</th>
                </tr>
              </thead>
              <tbody>
                {bill.invoices.map(i => (
                  <tr key={i.invoiceId}>
                    <th scope="row" data-label={t('admin.bills.invoices.column.invoice')}>
                      {stripe(`invoices/${i.invoiceId}`) ? (
                        <a href={stripe(`invoices/${i.invoiceId}`)!} target="_blank" rel="noreferrer">
                          {i.number ?? i.invoiceId}
                        </a>
                      ) : (
                        <span className="adm-mono">{i.number ?? i.invoiceId}</span>
                      )}
                      <span className="adm-sub">{t(INVOICE_KIND[i.kind])}</span>
                    </th>
                    <td data-label={t('admin.bills.column.status')}>{i.status}</td>
                    <td className="adm-num" data-label={t('admin.bills.invoices.column.total')}>
                      {usdOfCents(i.totalCents)}
                      {i.taxCents > 0 && (
                        <span className="adm-sub">
                          {t('admin.bills.invoices.tax', { amount: usdOfCents(i.taxCents) })}
                        </span>
                      )}
                    </td>
                    <td data-label={t('admin.bills.column.created')}>{day(i.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="adm-notice">{t('admin.bills.invoices.empty')}</p>
        )}
      </Card>

      {open && <BillDialog bill={bill} open={open} notify={notify} done={done} onClose={() => setOpen(null)} />}
    </>
  )
}

const RECHARGE_STATUS: Record<AdminBillDetail['recharges'][number]['status'], MessageKey> = {
  pending: msg('admin.bills.recharges.status.pending'),
  paid: msg('admin.bills.recharges.status.paid'),
  failed: msg('admin.bills.recharges.status.failed'),
  canceled: msg('admin.bills.recharges.status.canceled'),
}
const INVOICE_KIND: Record<AdminBillDetail['invoices'][number]['kind'], MessageKey> = {
  subscription: msg('admin.bills.invoices.kind.subscription'),
  recharge: msg('admin.bills.invoices.kind.recharge'),
  topup: msg('admin.bills.invoices.kind.topup'),
}
const CREDIT_KINDS = {
  credit: msg('admin.bills.credit.kind.credit'),
  writeoff: msg('admin.bills.credit.kind.writeoff'),
  adjustment: msg('admin.bills.credit.kind.adjustment'),
} as const satisfies Record<string, MessageKey>
type CreditKind = keyof typeof CREDIT_KINDS
const CREDIT_HELP: Record<CreditKind, MessageKey> = {
  credit: msg('admin.bills.credit.kind.creditHelp'),
  writeoff: msg('admin.bills.credit.kind.writeoffHelp'),
  adjustment: msg('admin.bills.credit.kind.adjustmentHelp'),
}

type DialogProps = {
  bill: AdminBillDetail
  open: Open
  notify: Notify
  /** Reads the bill again and answers the toast. */
  done: (text: string) => Promise<string>
  onClose: () => void
}

/** The dialog of one action on a bill: its own fields, then the reason. */
function BillDialog({ bill, open, notify, done, onClose }: DialogProps) {
  const t = useT()
  const billingAccountId = bill.id
  const [amount, setAmount] = useState(open.kind === 'credit' && open.amountCents ? String(open.amountCents / 100) : '')
  const [creditKind, setCreditKind] = useState<CreditKind>('credit')
  const [count, setCount] = useState(
    open.kind === 'concurrency' && bill.concurrentCallsCap !== null
      ? String(bill.concurrentCallsCap)
      : open.kind === 'cap'
        ? String(bill.rechargeCapBaseCents / 100)
        : '',
  )
  const [member, setMember] = useState(bill.members.find(m => m.id !== bill.owner.id)?.id ?? '')
  const [workspace, setWorkspace] = useState(bill.workspaces[0]?.id ?? '')
  const targets = bill.otherBills.filter(b => b.status !== 'canceled')
  const [target, setTarget] = useState(targets[0]?.id ?? '')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const props = { notify, onClose }

  const amountField = (label: string, aside?: string) => (
    <FormField id="adm-bill-amount" label={label} aside={aside} error={fieldError}>
      <Input
        id="adm-bill-amount"
        inputMode="decimal"
        placeholder={t('admin.bills.amount.placeholder')}
        value={amount}
        invalid={!!fieldError}
        readOnly={open.kind === 'credit' && !!open.rechargeId}
        onChange={e => setAmount(e.target.value)}
      />
    </FormField>
  )

  switch (open.kind) {
    case 'credit': {
      const kind: CreditKind = open.rechargeId ? 'credit' : creditKind
      return (
        <ReasonDialog
          {...props}
          title={t(open.rechargeId ? 'admin.bills.recharges.creditTitle' : 'admin.bills.credit.title')}
          description={t(open.rechargeId ? 'admin.bills.recharges.creditText' : 'admin.bills.credit.text', {
            balance: usdOfMicros(bill.balanceMicros),
          })}
          submit={t('admin.bills.credit.submit')}
          check={() => {
            const parsed = parseDollars(amount, { negative: kind === 'adjustment' })
            setFieldError('problem' in parsed ? parsed.problem : null)
            return 'problem' in parsed ? parsed.problem : null
          }}
          run={async (reason, requestId) => {
            const parsed = parseDollars(amount, { negative: kind === 'adjustment' })
            if ('problem' in parsed) throw new Error(parsed.problem)
            await runAdmin('billing.credit', {
              billingAccountId,
              kind,
              amountCents: parsed.cents,
              reason,
              requestId,
              ...(open.rechargeId ? { rechargeId: open.rechargeId } : {}),
            })
            return done(t('admin.bills.credit.done', { amount: usdOfCents(parsed.cents) }))
          }}
        >
          {!open.rechargeId && (
            <FormField id="adm-bill-kind" label={t('admin.bills.credit.kind.label')}>
              <Select
                id="adm-bill-kind"
                value={creditKind}
                onChange={setCreditKind}
                label={t('admin.bills.credit.kind.label')}
                options={(Object.keys(CREDIT_KINDS) as CreditKind[]).map(value => ({
                  value,
                  label: t(CREDIT_KINDS[value]),
                  description: t(CREDIT_HELP[value]),
                }))}
              />
            </FormField>
          )}
          {amountField(
            t('admin.bills.amount.label'),
            kind === 'adjustment' ? t('admin.bills.amount.negativeAside') : undefined,
          )}
        </ReasonDialog>
      )
    }
    case 'refund': {
      const available = Math.max(0, bill.balanceMicros - bill.reservedMicros)
      const payments = bill.refundable.filter(p => p.creditedMicros > p.refundedMicros)
      return (
        <ReasonDialog
          {...props}
          title={t('admin.bills.refund.title')}
          description={t('admin.bills.refund.text', { available: usdOfMicros(available) })}
          submit={t('admin.bills.refund.submit')}
          danger
          check={() => {
            const parsed = parseDollars(amount)
            setFieldError('problem' in parsed ? parsed.problem : null)
            return 'problem' in parsed ? parsed.problem : null
          }}
          run={async (reason, requestId) => {
            const parsed = parseDollars(amount)
            if ('problem' in parsed) throw new Error(parsed.problem)
            await runAdmin('billing.refund', { billingAccountId, amountCents: parsed.cents, reason, requestId })
            return done(t('admin.bills.refund.done', { amount: usdOfCents(parsed.cents) }))
          }}
        >
          {payments.length > 0 && (
            <ul className="adm-refundable">
              {payments.map(p => (
                <li key={p.entryId}>
                  {t('admin.bills.refund.payment', {
                    when: day(p.createdAt),
                    paid: usdOfMicros(p.creditedMicros),
                    left: usdOfMicros(p.creditedMicros - p.refundedMicros),
                  })}
                </li>
              ))}
            </ul>
          )}
          {amountField(t('admin.bills.amount.label'))}
        </ReasonDialog>
      )
    }
    case 'status': {
      const keys = {
        comped: [
          msg('admin.bills.status.compTitle'),
          msg('admin.bills.status.compText'),
          msg('admin.bills.status.compDone'),
        ],
        suspended: [
          msg('admin.bills.status.suspendTitle'),
          msg('admin.bills.status.suspendText'),
          msg('admin.bills.status.suspendDone'),
        ],
        active: [
          msg('admin.bills.status.resumeTitle'),
          msg('admin.bills.status.resumeText'),
          msg('admin.bills.status.resumeDone'),
        ],
      } as const
      const [title, text, doneKey] = keys[open.status]
      return (
        <ReasonDialog
          {...props}
          title={t(title)}
          description={t(text)}
          submit={t(title)}
          danger={open.status === 'suspended'}
          run={async reason => {
            await runAdmin('billing.adminSetStatus', { billingAccountId, status: open.status, reason })
            return done(t(doneKey))
          }}
        />
      )
    }
    case 'cap':
      return (
        <ReasonDialog
          {...props}
          title={t('admin.bills.cap.title')}
          description={t('admin.bills.cap.text', { cap: usdOfCents(bill.rechargeCapCents) })}
          submit={t('common.action.save')}
          check={() => {
            const parsed = parseDollars(count, { zero: true })
            setFieldError('problem' in parsed ? parsed.problem : null)
            return 'problem' in parsed ? parsed.problem : null
          }}
          run={async reason => {
            const parsed = parseDollars(count, { zero: true })
            if ('problem' in parsed) throw new Error(parsed.problem)
            await runAdmin('billing.setCap', { billingAccountId, capBaseCents: parsed.cents, reason })
            return done(t('admin.bills.cap.done', { amount: usdOfCents(parsed.cents) }))
          }}
        >
          <FormField id="adm-bill-cap" label={t('admin.bills.cap.label')} error={fieldError}>
            <Input
              id="adm-bill-cap"
              inputMode="decimal"
              value={count}
              invalid={!!fieldError}
              onChange={e => setCount(e.target.value)}
            />
          </FormField>
        </ReasonDialog>
      )
    case 'concurrency':
      return (
        <ReasonDialog
          {...props}
          title={t('admin.bills.concurrency.title')}
          description={t('admin.bills.concurrency.text', { count: bill.rulesConcurrentCalls })}
          submit={t('common.action.save')}
          check={() => {
            const parsed = parseCount(count, 1, 1000, { empty: true })
            setFieldError('problem' in parsed ? parsed.problem : null)
            return 'problem' in parsed ? parsed.problem : null
          }}
          run={async reason => {
            const parsed = parseCount(count, 1, 1000, { empty: true })
            if ('problem' in parsed) throw new Error(parsed.problem)
            await runAdmin('billing.setConcurrency', { billingAccountId, concurrentCalls: parsed.value, reason })
            return done(
              parsed.value === null
                ? t('admin.bills.concurrency.reset')
                : t('admin.bills.concurrency.done', { count: parsed.value }),
            )
          }}
        >
          <FormField
            id="adm-bill-calls"
            label={t('admin.bills.concurrency.label')}
            aside={t('admin.bills.concurrency.aside')}
            error={fieldError}
          >
            <Input
              id="adm-bill-calls"
              inputMode="numeric"
              value={count}
              invalid={!!fieldError}
              onChange={e => setCount(e.target.value)}
            />
          </FormField>
        </ReasonDialog>
      )
    case 'owner':
      return (
        <ReasonDialog
          {...props}
          title={t('admin.bills.owner.title')}
          description={t('admin.bills.owner.text')}
          submit={t('admin.bills.owner.submit')}
          check={() => (member ? null : t('admin.bills.owner.pick'))}
          run={async reason => {
            await runAdmin('billing.transferOwner', { billingAccountId, userId: member, reason })
            const to = bill.members.find(m => m.id === member)
            return done(t('admin.bills.owner.done', { owner: to?.email ?? member }))
          }}
        >
          <FormField id="adm-bill-owner" label={t('admin.bills.owner.label')}>
            <Select
              id="adm-bill-owner"
              value={member}
              onChange={setMember}
              label={t('admin.bills.owner.label')}
              options={bill.members.map(m => ({
                value: m.id,
                label: m.name ? `${m.name} (${m.email})` : m.email,
                disabled: m.id === bill.owner.id,
                description: m.id === bill.owner.id ? t('admin.bills.owner.current') : undefined,
              }))}
            />
          </FormField>
        </ReasonDialog>
      )
    case 'move':
      return (
        <ReasonDialog
          {...props}
          title={t('admin.bills.move.title')}
          description={t('admin.bills.move.text')}
          submit={t('admin.bills.move.submit')}
          check={() => (workspace && target ? null : t('admin.bills.move.pick'))}
          run={async (reason, requestId) => {
            await runAdmin('billing.moveWorkspace', {
              workspaceId: workspace,
              toBillingAccountId: target,
              reason,
              requestId,
            })
            await refreshQuery(billKey(target))
            const name = bill.workspaces.find(w => w.id === workspace)?.name ?? ''
            return done(t('admin.bills.move.done', { name }))
          }}
        >
          <FormField id="adm-bill-workspace" label={t('admin.bills.move.workspace')}>
            <Select
              id="adm-bill-workspace"
              value={workspace}
              onChange={setWorkspace}
              label={t('admin.bills.move.workspace')}
              options={bill.workspaces.map(w => ({ value: w.id, label: w.name }))}
            />
          </FormField>
          <FormField id="adm-bill-target" label={t('admin.bills.move.target')}>
            <Select
              id="adm-bill-target"
              value={target}
              onChange={setTarget}
              label={t('admin.bills.move.target')}
              options={targets.map(b => ({
                value: b.id,
                label: b.owner ?? b.id,
                description: `${t(b.kind === 'partner' ? 'admin.bills.kind.partner' : 'admin.bills.kind.cloud')} · ${t(STATUS[b.status])}`,
              }))}
            />
          </FormField>
        </ReasonDialog>
      )
  }
}

type ReasonDialogProps = {
  title: string
  description?: ReactNode
  submit: string
  /** A step that takes something away (suspend, deny, refund): its button is red. */
  danger?: boolean
  /** The other fields' problem, if any; shown by the field itself. */
  check?: () => string | null
  /** Does it; answers the toast. `requestId`: the same for every try in this dialog. */
  run: (reason: string, requestId: string) => Promise<string>
  notify: Notify
  onClose: () => void
  children?: ReactNode
}

/** Every billing write asks why: the reason is kept in the audit log with the action. */
function ReasonDialog({
  title,
  description,
  submit,
  danger,
  check,
  run,
  notify,
  onClose,
  children,
}: ReasonDialogProps) {
  const t = useT()
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // One per dialog, so a retry after an error or a lost answer is the same request (Stripe's idempotency key).
  const [requestId] = useState(newRequestId)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    const fieldProblem = check?.() ?? null
    const why = reasonProblem(reason)
    setReasonError(why)
    if (fieldProblem || why) return
    setProblem(null)
    setBusy(true)
    try {
      const text = await run(reason.trim(), requestId)
      onClose()
      notify(text)
    } catch (err) {
      setProblem(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      title={title}
      description={description}
      onClose={onClose}
      onSubmit={e => void onSubmit(e)}
      footer={
        <>
          <Button onClick={onClose}>{t('common.action.cancel')}</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} busy={busy}>
            {submit}
          </Button>
        </>
      }
    >
      {children}
      <FormField
        id="adm-bill-reason"
        label={t('admin.bills.reason.label')}
        aside={t('admin.bills.reason.aside')}
        error={reasonError}
      >
        <Textarea
          id="adm-bill-reason"
          rows={2}
          value={reason}
          invalid={!!reasonError}
          placeholder={t('admin.bills.reason.placeholder')}
          onChange={e => setReason(e.target.value)}
        />
      </FormField>
      {problem && <FormMessage>{problem}</FormMessage>}
    </Dialog>
  )
}
