// Server admin › Billing (docs/billing.md §11, PR 13): the bills of this install with their ledger, payments and
// invoices; what waits for review; the Stripe event inbox; who may sign up on their own, with the bot check; the
// install's billing rules; and Stripe with the billing switch (BillingProviders.tsx, LIN-556). Every write asks why (kept in the audit log) and runs through runAdmin, so the server's passkey step-up asks
// for the admin's passkey first; the ones that reach Stripe send one request id per dialog (its idempotency key).
//
// The page: a status line on top (billing on and its mode, sign-up open or why not, what needs the admin), then one
// section at a time, each with its own address (`#admin/billing/<tab>`, route.ts), so only the section on screen loads
// its rows. The status line is one read (billing.adminSummary), kept between visits.
import type {
  AdminBillDetail,
  AdminBillingSummary,
  AdminBillRow,
  AdminBillStatus,
  AdminReviewRow,
  AdminStripeEvent,
  BillingEventFilter,
  BillingRulesData,
  RadarRiskLevel,
  SelfServeData,
  StatusState,
  TaxAddressMissingData,
} from '@linedesk/actions'
import { PLAN_PRICE_FLOOR, RADAR_RISK_LEVELS } from '@linedesk/actions'
import { SIGNUP_RULE_RANGES, type SignupCountRule } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { T, useT } from '@linedesk/i18n/react'
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react'
import { refreshQuery, setQueryData, useQuery } from '../cachedQuery.ts'
import { fmt } from '../i18n/format.ts'
import { AppLink, appLink, LinkButton } from '../ui/AppLink.tsx'
import { Checkbox, Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { Card, Dialog, FormField, FormMessage, HelpTip, Input, onSaveKey, SaveBar, Textarea } from '../ui/form.tsx'
import { Badge, Button, cx, Note } from '../ui/kit.tsx'
import { Loading, Skeleton, SkeletonRows } from '../ui/LoadStates.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { AdminList, type Column, type ListKeys } from './AdminList.tsx'
import { ActionBar, type AdminAction } from './actions.tsx'
import { BillingProviders, type BillingProvidersProps } from './BillingProviders.tsx'
import { runAdmin } from './api.ts'
import {
  ago,
  BILL_FILTERS,
  type BillFilter,
  billFilterOfHash,
  billsHref,
  changedFields,
  customFields,
  defaultText,
  eventFilterOfHash,
  eventsHref,
  blankIsNone,
  exactTime,
  type FieldUnit,
  filterBills,
  newRequestId,
  parseCount,
  parseDollars,
  planFloorText,
  RULE_GROUPS,
  type RuleField,
  type RuleGroupId,
  type RulesForm,
  rateOfMicros,
  reasonProblem,
  ruleUnit,
  rulesForm,
  rulesFromForm,
  SIGNUP_GROUPS,
  type SignupForm,
  signupChanges,
  signupDirty,
  signupForm,
  signupFromForm,
  TAX_FIELD,
  usdOfCents,
  usdOfMicros,
  usdSymbol,
} from './billingModel.ts'
import { errorText, type Notify } from './notify.ts'
import { day, EMPTY, when } from './parts.tsx'
import { BILLING_TABS, type BillingTab, billingTab } from './route.ts'
import { Fact } from './WorkspacesPage.tsx'

type Translate = ReturnType<typeof useT>

const BILLS = 'admin.billing.bills'
const REVIEW = 'admin.billing.review'
const RULES = 'admin.billing.rules'
const SUMMARY = 'admin.billing.summary'
const TAX_ADDRESS = 'admin.billing.taxAddressMissing'
const SELF_SERVE = 'admin.billing.selfServe'
const billKey = (id: string) => `admin.billing.bill.${id}`
const eventsKey = (filter: BillingEventFilter) => `admin.billing.events.${filter}`

const loadBills = async () => ((await runAdmin('billing.adminBills', {})) as { bills: AdminBillRow[] }).bills
const loadBill = (id: string) => async () =>
  (await runAdmin('billing.adminBill', { billingAccountId: id })) as unknown as AdminBillDetail
const loadReview = async () =>
  (await runAdmin('billing.adminReview', {})) as unknown as { held: AdminReviewRow[]; newTrials: AdminReviewRow[] }
const loadSummary = async () => (await runAdmin('billing.adminSummary', {})) as unknown as AdminBillingSummary
const loadRules = async () => (await runAdmin('billingRules.get', {})) as unknown as BillingRulesData
const loadTaxAddress = async () =>
  ((await runAdmin('billing.adminTaxAddressMissing', {})) as unknown as TaxAddressMissingData).taxAddressMissing
const loadSelfServe = async () => (await runAdmin('signup.getSelfServe', {})) as unknown as SelfServeData
type EventsPage = { events: AdminStripeEvent[]; next: string | null }
const loadEvents = (filter: BillingEventFilter, before?: string) => async () =>
  (await runAdmin('billing.adminEvents', { filter, ...(before ? { before } : {}) })) as unknown as EventsPage

/**
 * The status line, the rules and the sign-up settings hold no customer's data: kept in this browser between visits
 * (per member, forgotten on sign-out), so the page shows them at once and reads them again in the background. Bills
 * and events, which name customers, stay in memory only.
 */
const KEPT = { persist: true } as const

/** After a write: the bill, the list, the review and the status line read again, so the page shows what was just done. */
async function refreshBill(id: string) {
  await Promise.all([refreshQuery(billKey(id)), refreshQuery(BILLS), refreshQuery(REVIEW), refreshQuery(SUMMARY)])
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

/** A bill's status as a badge: red where money is owed or calls are stopped, ink when it pays, blue-grey in the trial. */
const STATUS_TONE: Record<AdminBillStatus, 'neutral' | 'ok' | 'danger' | 'info' | 'outline'> = {
  pending_payment: 'outline',
  trialing: 'info',
  active: 'ok',
  past_due: 'danger',
  suspended: 'danger',
  canceled: 'neutral',
  comped: 'neutral',
}

function StatusBadge({ status }: { status: AdminBillStatus }) {
  const t = useT()
  return <Badge tone={STATUS_TONE[status]}>{t(STATUS[status])}</Badge>
}

const RISK: Record<RadarRiskLevel, MessageKey> = {
  normal: msg('admin.bills.risk.normal'),
  elevated: msg('admin.bills.risk.elevated'),
  highest: msg('admin.bills.risk.highest'),
  not_assessed: msg('admin.bills.risk.notAssessed'),
  unknown: msg('admin.bills.risk.unknown'),
}

/** Stripe Radar's risk level of the trial's card check; a level Radar adds later shows as it comes. */
function RiskBadge({ level }: { level: string | null }) {
  const t = useT()
  if (!level) return <span className="adm-muted">{t('admin.bills.risk.none')}</span>
  const key = RISK[level as RadarRiskLevel]
  const tone = level === 'highest' ? 'danger' : level === 'elevated' ? 'outline' : 'neutral'
  return <Badge tone={tone}>{key ? t(key) : level}</Badge>
}

/** A moment as "3 hours ago", the exact time on hover and for screen readers' `dateTime`. */
function Ago({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={exactTime(iso)}>
      {ago(iso)}
    </time>
  )
}

const ownerText = (t: Translate, owner: { email: string | null; name: string | null }) =>
  owner.email ?? owner.name ?? t('admin.bills.noOwner')

/** The title of `#admin/billing/<id>`: whose bill it is, from the bill or the list, whichever is here first. */
export function useBillTitle(id: string | null): string | null {
  const t = useT()
  const billId = billingTab(id) === null ? id : null
  const bill = useQuery(billId ? billKey(billId) : null, loadBill(billId ?? '')).data
  const bills = useQuery(billId ? BILLS : null, loadBills).data
  if (!billId) return null
  const owner = bill?.owner ?? bills?.find(b => b.id === billId)?.owner
  return owner ? t('admin.bills.detail.title', { owner: ownerText(t, owner) }) : t('admin.bills.detail.untitled')
}

type Props = {
  /** A section of the page (route.ts `BILLING_TABS`) or a bill's id. */
  id: string | null
  onOpen: (id: string) => void
  notify: Notify
  keysRef: { current: ListKeys | null }
  /** Stripe and the bot check: the admin data and the providers' status, as on Server admin › Providers. */
  providers: BillingProvidersProps
}

export function Billing({ id, onOpen, notify, keysRef, providers }: Props) {
  const tab = billingTab(id)
  if (!tab) return <BillDetail id={id!} notify={notify} />
  return (
    <>
      <BillingStatus />
      <BillingTabs current={tab} />
      {tab === 'overview' && <OverviewSection />}
      {tab === 'bills' && <BillsList onOpen={onOpen} keysRef={keysRef} />}
      {tab === 'review' && <ReviewCard onOpen={onOpen} notify={notify} />}
      {tab === 'events' && <EventsCard notify={notify} />}
      {tab === 'signup' && (
        <>
          <SelfServeCard notify={notify} />
          <BillingProviders part="bot_check" {...providers} />
          <SignupRulesCard notify={notify} />
        </>
      )}
      {tab === 'rules' && <RulesCard notify={notify} />}
      {tab === 'stripe' && <BillingProviders part="billing" {...providers} />}
    </>
  )
}

// ---- The status line ----

/** One fact of the status line: its mark and word, a muted line under it, and the place that fixes it. */
type StatusFact = { id: string; label: string; state: StatusState; value: string; line: string | null; href: string }

/** Whether billing through Stripe runs, in which mode, or what stops it. */
function billingFact(t: Translate, s: AdminBillingSummary): StatusFact {
  const b = s.billing
  const base = { id: 'billing', label: t('admin.bills.summary.billing'), href: '#admin/billing/stripe' }
  if (!b.connected)
    return {
      ...base,
      state: 'missing',
      value: t('admin.bills.summary.notConnected'),
      line: t('admin.bills.summary.connect'),
    }
  if (b.mode === 'live' && !b.liveAllowed)
    return {
      ...base,
      state: 'failing',
      value: t('admin.bills.summary.liveRefused'),
      line: t('admin.billing.liveRefused'),
    }
  if (!b.guardsOk)
    return { ...base, state: 'failing', value: t('admin.bills.summary.paused'), line: t('admin.billing.guardsMissing') }
  const mode = t(b.mode === 'live' ? 'admin.bills.summary.live' : 'admin.bills.summary.test')
  if (!b.on)
    return {
      ...base,
      state: 'off',
      value: t('admin.bills.summary.off'),
      line: t('admin.bills.summary.turnOn', { mode }),
    }
  return {
    ...base,
    state: b.mode === 'live' ? 'works' : 'partly',
    value: t('admin.bills.summary.on', { mode }),
    line: t(s.automaticTax ? 'admin.bills.summary.taxOn' : 'admin.bills.summary.taxOff'),
  }
}

const CLOSED_BECAUSE: Record<NonNullable<AdminBillingSummary['selfServe']['closedBecause']>, MessageKey> = {
  switched_off: msg('admin.bills.summary.signup.switchedOff'),
  billing_not_in_effect: msg('admin.bills.summary.signup.billing'),
  terms_missing: msg('admin.bills.summary.signup.terms'),
  bot_check_missing: msg('admin.bills.summary.signup.botCheck'),
}

/** Self-serve sign-up: open, or closed and why (switched on but closed is a problem; switched off is a choice). */
function signupFact(t: Translate, s: AdminBillingSummary): StatusFact {
  const { on, open, closedBecause } = s.selfServe
  return {
    id: 'signup',
    label: t('admin.bills.selfServe.title'),
    state: open ? 'works' : on ? 'failing' : 'off',
    value: t(open ? 'admin.bills.selfServe.state.open' : 'admin.bills.selfServe.state.closed'),
    line: closedBecause ? t(CLOSED_BECAUSE[closedBecause]) : t('admin.bills.selfServe.openNow'),
    href: '#admin/billing/signup',
  }
}

/** What the admin has to decide: bills held for review, and how many trials are new. */
function reviewFact(t: Translate, s: AdminBillingSummary): StatusFact {
  return {
    id: 'review',
    label: t('admin.bills.review.title'),
    state: s.held ? 'partly' : 'works',
    value: s.held ? t('admin.bills.summary.held', { count: s.held }) : t('admin.bills.summary.nothingHeld'),
    line: t('admin.bills.summary.newTrials', { count: s.newTrials }),
    href: '#admin/billing/review',
  }
}

/** Bills that owe money or are stopped. */
function billsFact(t: Translate, s: AdminBillingSummary): StatusFact {
  const owing = s.bills.past_due + s.bills.suspended
  const total = Object.values(s.bills).reduce((sum, n) => sum + n, 0)
  return {
    id: 'bills',
    label: t('admin.bills.what'),
    state: owing ? 'partly' : 'works',
    value: owing
      ? t('admin.bills.summary.owing', { count: owing })
      : t('admin.bills.summary.billCount', { count: total }),
    line: owing
      ? t('admin.bills.summary.owingLine', { pastDue: s.bills.past_due, suspended: s.bills.suspended })
      : null,
    href: owing ? billsHref(s.bills.past_due ? 'past_due' : 'suspended') : billsHref('all'),
  }
}

/** Stripe events that did not go through. */
function eventsFact(t: Translate, s: AdminBillingSummary): StatusFact {
  const stuck = s.events.failed + s.events.unhandled
  return {
    id: 'events',
    label: t('admin.bills.events.title'),
    state: s.events.failed ? 'failing' : stuck ? 'partly' : 'works',
    value: stuck ? t('admin.bills.summary.eventsStuck', { count: stuck }) : t('admin.bills.summary.eventsOk'),
    line: s.events.waiting ? t('admin.bills.summary.eventsWaiting', { count: s.events.waiting }) : null,
    href: eventsHref(s.events.failed ? 'failed' : s.events.unhandled ? 'unhandled' : 'all'),
  }
}

const facts = (t: Translate, s: AdminBillingSummary) => [
  billingFact(t, s),
  signupFact(t, s),
  reviewFact(t, s),
  billsFact(t, s),
  eventsFact(t, s),
]

const useSummary = () => useQuery(SUMMARY, loadSummary, KEPT)

/** The top of the page: five facts, each a link to where it is changed or looked at. */
function BillingStatus() {
  const t = useT()
  const query = useSummary()
  const data = query.data
  return (
    <section className="k-card adm-billstatus" aria-label={t('admin.bills.summary.label')}>
      <Loading
        what={t('admin.bills.summary.label')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        className="adm-billstatus-grid"
        skeleton={[0, 1, 2, 3, 4].map(i => (
          <div key={i} className="adm-billfact">
            <Skeleton shape="text" width={70} />
            <Skeleton shape="text" width={110} />
          </div>
        ))}
      >
        {data &&
          facts(t, data).map(f => (
            <a
              key={f.id}
              className="adm-billfact"
              href={f.href}
              title={t('admin.bills.summary.openTip', { part: f.label })}
            >
              <span className="adm-billfact-label">
                <StatusMark state={f.state} label={f.value} />
                {f.label}
              </span>
              <span className="adm-billfact-value">{f.value}</span>
              {f.line && <span className="adm-billfact-line">{f.line}</span>}
            </a>
          ))}
      </Loading>
    </section>
  )
}

const TAB_LABELS: Record<BillingTab, MessageKey> = {
  overview: msg('admin.bills.tab.overview'),
  bills: msg('admin.bills.tab.bills'),
  review: msg('admin.bills.tab.review'),
  events: msg('admin.bills.tab.events'),
  signup: msg('admin.bills.tab.signup'),
  rules: msg('admin.bills.tab.rules'),
  stripe: msg('admin.bills.tab.stripe'),
}

const tabHref = (tab: BillingTab) => (tab === 'overview' ? '#admin/billing' : `#admin/billing/${tab}`)

/** The page's sections, as links: each has its own address, so Back, reload and a shared link land on it. */
function BillingTabs({ current }: { current: BillingTab }) {
  const t = useT()
  const summary = useSummary().data
  // A number only where something waits for the admin.
  const counts: Partial<Record<BillingTab, number>> = summary
    ? { review: summary.held, events: summary.events.failed + summary.events.unhandled }
    : {}
  return (
    <nav className="adm-billtabs" aria-label={t('admin.bills.tab.label')}>
      <div className="ib-tabs">
        {BILLING_TABS.map(tab => (
          <a key={tab} href={tabHref(tab)} className="ib-tab" aria-current={tab === current ? 'page' : undefined}>
            {t(TAB_LABELS[tab])}
            {counts[tab] ? <span className="n">{fmt().number(counts[tab])}</span> : null}
          </a>
        ))}
      </div>
    </nav>
  )
}

// ---- Overview ----

/**
 * The overview below the status line: the bills by status, each a link to them; a calm line when every fact above
 * works.
 */
function OverviewSection() {
  const t = useT()
  const query = useSummary()
  const data = query.data
  const calm = !!data && facts(t, data).every(f => f.state === 'works' || f.state === 'off')
  return (
    <Card
      title={t('admin.bills.overview.byStatus')}
      description={t('admin.bills.overview.byStatusText')}
      className="adm-detail"
    >
      <Loading
        what={t('admin.bills.overview.byStatus')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonRows rows={1} columns={4} />}
      >
        {data && (
          <div className="adm-statuscounts">
            {(Object.keys(STATUS) as AdminBillStatus[]).map(status => (
              <a key={status} className="adm-statuscount" href={billsHref(status)}>
                <b>{fmt().number(data.bills[status])}</b>
                <StatusBadge status={status} />
              </a>
            ))}
          </div>
        )}
        {calm && <p className="adm-notice">{t('admin.bills.overview.calm')}</p>}
      </Loading>
    </Card>
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
    render: b => <Ago iso={b.createdAt} />,
  },
]

const filterLabel = (t: Translate, value: BillFilter) =>
  value === 'all' ? t('admin.bills.filter.all') : value === 'held' ? t('admin.bills.filter.held') : t(STATUS[value])

/** The filter a link asked for (`#admin/billing/bills?status=…`), followed when the address changes. */
function useHashFilter<F extends string>(parse: (hash: string) => F, href: (filter: F) => string) {
  const [filter, setFilter] = useState(() => parse(typeof window === 'undefined' ? '' : window.location.hash))
  useEffect(() => {
    const onHash = () => setFilter(parse(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [parse])
  /** A new filter replaces the address (no history entry per click), so a reload or a shared link keeps it. */
  const choose = (next: F) => {
    setFilter(next)
    window.history.replaceState(window.history.state, '', href(next))
  }
  return [filter, choose] as const
}

function BillsList({ onOpen, keysRef }: { onOpen: (id: string) => void; keysRef: { current: ListKeys | null } }) {
  const t = useT()
  const query = useQuery(BILLS, loadBills)
  const columns = useMemo(() => billColumns(t), [t])
  const [filter, setFilter] = useHashFilter(billFilterOfHash, billsHref)
  const shown = useMemo(() => filterBills(query.data ?? [], filter), [query.data, filter])
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
  const bills = query.data
  // Every filter that has bills, and the one chosen even when it has none.
  const chips = BILL_FILTERS.filter(value => value === 'all' || value === filter || filterBills(bills, value).length)
  return (
    <AdminList
      rows={shown}
      tools={
        <div className="adm-chips" role="group" aria-label={t('admin.bills.filter.label')}>
          {chips.map(value => (
            <button
              key={value}
              type="button"
              className="adm-chip"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {filterLabel(t, value)}
              <span className="n">{fmt().number(filterBills(bills, value).length)}</span>
            </button>
          ))}
        </div>
      }
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
      empty={
        filter === 'all' ? (
          <>
            {t('admin.bills.empty')} <T k="admin.bills.emptyHint" values={{ link: appLink('#admin/billing/signup') }} />
          </>
        ) : (
          <>
            {t('admin.bills.filter.empty')}{' '}
            <LinkButton onClick={() => setFilter('all')}>{t('admin.bills.filter.showAll')}</LinkButton>
          </>
        )
      }
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
      help={t('admin.bills.review.radarHelp')}
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
                  <th scope="col">{t('admin.bills.review.column.risk')}</th>
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
                    <td data-label={t('admin.bills.review.column.risk')}>
                      <RiskBadge level={row.cardRiskLevel} />
                    </td>
                    <td data-label={t('admin.bills.review.column.since')}>
                      <Ago iso={row.heldForReviewAt ?? row.createdAt} />
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
          <p className="adm-notice">
            {t('admin.bills.review.empty')} {t('admin.bills.review.emptyHint')}
          </p>
        )}
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
const EVENT_TONE: Record<AdminStripeEvent['state'], 'neutral' | 'ok' | 'danger' | 'outline'> = {
  processed: 'ok',
  waiting: 'neutral',
  failed: 'danger',
  unhandled: 'outline',
}
const FILTERS: Record<BillingEventFilter, MessageKey> = {
  all: msg('admin.bills.events.filter.all'),
  waiting: msg('admin.bills.events.filter.waiting'),
  failed: msg('admin.bills.events.filter.failed'),
  unhandled: msg('admin.bills.events.filter.unhandled'),
}

function EventsCard({ notify }: { notify: Notify }) {
  const t = useT()
  const [filter, setFilter] = useHashFilter(eventFilterOfHash, eventsHref)
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
    await Promise.all([refreshQuery(eventsKey(filter)), refreshQuery(SUMMARY)])
    return t('admin.bills.events.queued', { type: event.type })
  }

  return (
    <Card
      title={t('admin.bills.events.title')}
      description={t('admin.bills.events.descriptionShort')}
      help={t('admin.bills.events.description')}
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
            <table className="adm-table adm-stack adm-events">
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
                      <Badge tone={EVENT_TONE[e.state]}>{t(EVENT_STATE[e.state])}</Badge>
                    </td>
                    <td data-label={t('admin.bills.events.column.received')}>
                      <Ago iso={e.receivedAt} />
                    </td>
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
        ) : filter === 'all' ? (
          <p className="adm-notice">
            <T k="admin.bills.events.emptyHow" values={{ link: appLink('#admin/billing/stripe') }} />
          </p>
        ) : (
          <p className="adm-notice">
            {t('admin.bills.events.empty')}{' '}
            <LinkButton onClick={() => setFilter('all')}>{t('admin.bills.events.showAll')}</LinkButton>
          </p>
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

/**
 * The switch and whether sign-up is really open: switched on is not open while something it needs is missing (billing
 * through Stripe, or the Turnstile keys while the bot check is on), and the card says so plainly.
 */
function SelfServeCard({ notify }: { notify: Notify }) {
  const t = useT()
  const query = useQuery(SELF_SERVE, loadSelfServe, KEPT)
  const [asking, setAsking] = useState<boolean | null>(null)
  const data = query.data
  const link = { link: appLink('#admin/billing/stripe') }
  return (
    <Card
      title={t('admin.bills.selfServe.title')}
      actions={
        data && (
          <Badge tone={data.open ? 'ok' : data.on ? 'danger' : 'neutral'} dot={data.open}>
            {t(data.open ? 'admin.bills.selfServe.state.open' : 'admin.bills.selfServe.state.closed')}
          </Badge>
        )
      }
      className="adm-detail"
    >
      <div className="swrow">
        <div>
          <b>{t('admin.bills.selfServe.switch')}</b>
          <span className="help">
            {data && !data.billingInEffect && !data.on
              ? t('admin.bills.selfServe.needsBilling')
              : data?.open
                ? t('admin.bills.selfServe.openNow')
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
            // Off always works; on needs billing through Stripe in effect and the terms set (A9).
            disabled={!data || (!data.on && (!data.billingInEffect || data.termsMissing.length > 0))}
          />
        </Loading>
      </div>
      {data?.on && data.closedBecause === 'bot_check_missing' && (
        <Note tone="danger">
          <T k="admin.bills.selfServe.closed.botCheck" values={{ link: appLink('#admin/billing/signup') }} />
        </Note>
      )}
      {data?.on && data.closedBecause === 'billing_not_in_effect' && (
        <Note tone="danger">
          <T k="admin.bills.selfServe.closed.billing" values={link} />
        </Note>
      )}
      {data && data.termsMissing.length > 0 && (
        <Note tone={data.on ? 'danger' : 'warning'}>
          {t(data.on ? 'admin.bills.selfServe.termsMissingOn' : 'admin.bills.selfServe.termsMissing', {
            vars: data.termsMissing.join(', '),
          })}
        </Note>
      )}
      {asking !== null && (
        <ReasonDialog
          title={t(asking ? 'admin.bills.selfServe.onTitle' : 'admin.bills.selfServe.offTitle')}
          description={t(asking ? 'admin.bills.selfServe.onText' : 'admin.bills.selfServe.offText')}
          submit={t(asking ? 'admin.bills.selfServe.on' : 'admin.bills.selfServe.off')}
          run={async reason => {
            const saved = (await runAdmin('signup.setSelfServe', { on: asking, reason })) as unknown as SelfServeData
            setQueryData<SelfServeData | undefined>(SELF_SERVE, saved, KEPT)
            await refreshQuery(SUMMARY)
            return t(saved.on ? 'admin.bills.selfServe.turnedOn' : 'admin.bills.selfServe.turnedOff')
          }}
          notify={notify}
          onClose={() => setAsking(null)}
        />
      )}
    </Card>
  )
}

// ---- One number field of the rules and limits editors ----

const UNIT_END: Partial<Record<FieldUnit, MessageKey>> = {
  usdPerMinute: msg('admin.bills.unit.perMinute'),
  minutes: msg('admin.bills.unit.minutes'),
  days: msg('admin.bills.unit.days'),
  seconds: msg('admin.bills.unit.seconds'),
  calls: msg('admin.bills.unit.calls'),
}

type NumberFieldProps = {
  id: string
  label: string
  /** The detail behind the (?): what the field does, and the server's limit for it. */
  help: string
  value: string
  /** The field's default, as the form holds it ("11"), and as the page says it ("$11.00"). */
  fallback: string
  fallbackText: string
  unit: FieldUnit | null
  error: string | null
  /** Empty is a value of its own (none), not the default: no default as the placeholder. */
  blankIsNone?: boolean
  onChange: (value: string) => void
}

/**
 * A number with its unit inside the field and its default as the placeholder: an empty field takes the default. A
 * value of its own shows the default and a Reset beside the label, so the install's own values stand out.
 */
function NumberField(props: NumberFieldProps) {
  const { id, label, help, value, fallback, fallbackText, unit, error, blankIsNone: blankNone, onChange } = props
  const t = useT()
  const own = (value.trim() !== '' || !!blankNone) && value.trim() !== fallback.trim()
  const end = unit && UNIT_END[unit]
  const money = unit === 'usd' || unit === 'usdPerMinute'
  return (
    <FormField
      id={id}
      label={label}
      help={help}
      error={error}
      className={cx(own && 'adm-own')}
      aside={
        own ? (
          <span className="adm-default">
            {t('admin.bills.rules.default', { value: fallbackText || EMPTY })}
            {' · '}
            <LinkButton title={t('admin.bills.rules.resetTip')} onClick={() => onChange(fallback)}>
              {t('admin.bills.rules.reset')}
            </LinkButton>
          </span>
        ) : null
      }
    >
      <Input
        id={id}
        inputMode="decimal"
        size="sm"
        value={value}
        placeholder={blankNone ? undefined : fallback}
        invalid={!!error}
        start={money ? <span className="adm-unit">{usdSymbol()}</span> : undefined}
        end={end ? <span className="adm-unit">{t(end)}</span> : undefined}
        onChange={e => onChange(e.target.value)}
      />
    </FormField>
  )
}

// ---- Sign-up limits ----

const SIGNUP_LABELS: Record<SignupCountRule, [MessageKey, MessageKey]> = {
  codesPerAddressHour: [
    msg('admin.bills.signupRules.field.codesPerAddressHour'),
    msg('admin.bills.signupRules.field.codesPerAddressHour.help'),
  ],
  codesPerAddressDay: [
    msg('admin.bills.signupRules.field.codesPerAddressDay'),
    msg('admin.bills.signupRules.field.codesPerAddressDay.help'),
  ],
  signupsPerIpHour: [
    msg('admin.bills.signupRules.field.signupsPerIpHour'),
    msg('admin.bills.signupRules.field.signupsPerIpHour.help'),
  ],
  signupsPerIpDay: [
    msg('admin.bills.signupRules.field.signupsPerIpDay'),
    msg('admin.bills.signupRules.field.signupsPerIpDay.help'),
  ],
  codesPerInstallHour: [
    msg('admin.bills.signupRules.field.codesPerInstallHour'),
    msg('admin.bills.signupRules.field.codesPerInstallHour.help'),
  ],
  pendingDays: [
    msg('admin.bills.signupRules.field.pendingDays'),
    msg('admin.bills.signupRules.field.pendingDays.help'),
  ],
  trialWorkspacesCloud: [
    msg('admin.bills.signupRules.field.trialWorkspacesCloud'),
    msg('admin.bills.signupRules.field.trialWorkspacesCloud.help'),
  ],
  trialNumbersPerWorkspace: [
    msg('admin.bills.signupRules.field.trialNumbersPerWorkspace'),
    msg('admin.bills.signupRules.field.trialNumbersPerWorkspace.help'),
  ],
}
const SIGNUP_GROUP_TITLES: Record<(typeof SIGNUP_GROUPS)[number]['id'], [MessageKey, MessageKey]> = {
  codes: [msg('admin.bills.signupRules.group.codes'), msg('admin.bills.signupRules.group.codes.text')],
  trial: [msg('admin.bills.signupRules.group.trial'), msg('admin.bills.signupRules.group.trial.text')],
}

/** The install's sign-up limits (`signup.rules`), in groups, saved together from one bar. */
function SignupRulesCard({ notify }: { notify: Notify }) {
  const t = useT()
  const query = useQuery(SELF_SERVE, loadSelfServe, KEPT)
  const data = query.data
  const saved = useMemo(() => (data ? signupForm(data.rules) : null), [data])
  const [form, setForm] = useState<SignupForm | null>(saved)
  const [problems, setProblems] = useState<string[]>([])
  const [asking, setAsking] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    if (saved) setForm(saved)
  }, [saved])
  const dirty = !!form && !!saved && signupDirty(form, saved)
  // Turning the bot check off loosens sign-up most: the confirmation says so and the button is red.
  const botCheckOff = !!data?.rules.turnstile && form?.turnstile === false

  function save(e: FormEvent) {
    e.preventDefault()
    if (!data || !form) return
    const parsed = signupFromForm(form, data.defaults)
    setProblems(parsed.problems)
    if ('rules' in parsed) setAsking(parsed.rules)
  }
  const setCount = (field: SignupCountRule, value: string) =>
    setForm(f => f && { ...f, counts: { ...f.counts, [field]: value } })
  const toggleLevel = (level: string, on: boolean) =>
    setForm(
      f =>
        f && {
          ...f,
          reviewRiskLevels: on
            ? [...f.reviewRiskLevels.filter(l => l !== level), level]
            : f.reviewRiskLevels.filter(l => l !== level),
        },
    )
  const loading = (
    <Loading
      what={t('admin.bills.signupRules.title')}
      loading
      error={query.error}
      onRetry={() => void query.reload()}
      skeleton={<SkeletonRows rows={4} columns={2} />}
    />
  )
  if (!data || !form)
    return (
      <Card title={t('admin.bills.signupRules.title')} className="adm-detail">
        {loading}
      </Card>
    )
  return (
    <form onSubmit={save} onKeyDown={e => onSaveKey(e, dirty)} className="adm-rules">
      <Card
        title={t('admin.bills.signupRules.title')}
        description={t('admin.bills.signupRules.descriptionShort')}
        help={t('admin.bills.signupRules.description')}
        className="adm-detail"
      >
        {data.problems.length > 0 && (
          <Note tone="warning">{t('admin.bills.signupRules.ignored', { fields: data.problems.join(', ') })}</Note>
        )}
        <div className="swrow adm-swrow-first">
          <div>
            <b>
              {t('admin.bills.signupRules.turnstile')}
              <HelpTip text={t('admin.bills.signupRules.turnstile.help')} />
            </b>
            {form.turnstile && !data.turnstileReady && (
              <span className="help">{t('admin.bills.signupRules.turnstile.missingKeys')}</span>
            )}
          </div>
          <Switch
            on={form.turnstile}
            onChange={on => setForm(f => f && { ...f, turnstile: on })}
            label={t('admin.bills.signupRules.turnstile')}
          />
        </div>
        {!form.turnstile && <Note tone="warning">{t('admin.bills.signupRules.turnstile.offWarning')}</Note>}
        <FormField
          id="adm-signup-domains"
          label={t('admin.bills.signupRules.blockedDomains')}
          help={t('admin.bills.signupRules.blockedDomains.help')}
        >
          <Textarea
            id="adm-signup-domains"
            rows={2}
            value={form.blockedDomains}
            placeholder={t('admin.bills.signupRules.blockedDomains.placeholder')}
            onChange={e => setForm(f => f && { ...f, blockedDomains: e.target.value })}
          />
        </FormField>
      </Card>
      {SIGNUP_GROUPS.map(group => {
        const [title, text] = SIGNUP_GROUP_TITLES[group.id]
        return (
          <Card key={group.id} title={t(title)} description={t(text)} className="adm-detail">
            <div className="adm-rules-grid">
              {group.fields.map(field => {
                const [min, max] = SIGNUP_RULE_RANGES[field]
                const [label, help] = SIGNUP_LABELS[field]
                const fallback = String(data.defaults[field])
                return (
                  <NumberField
                    key={field}
                    id={`adm-signup-${field}`}
                    label={t(label)}
                    help={`${t(help)} ${t('admin.bills.signupRules.range', { min, max })}`}
                    value={form.counts[field]}
                    fallback={fallback}
                    fallbackText={fmt().number(data.defaults[field])}
                    unit={field === 'pendingDays' ? 'days' : null}
                    error={problems.includes(field) ? t('admin.bills.signupRules.notInRange', { min, max }) : null}
                    onChange={value => setCount(field, value)}
                  />
                )
              })}
            </div>
          </Card>
        )
      })}
      <Card
        title={t('admin.bills.signupRules.reviewRiskLevels')}
        description={t('admin.bills.signupRules.reviewRiskLevels.short')}
        help={t('admin.bills.signupRules.reviewRiskLevels.help')}
        className="adm-detail"
      >
        <fieldset className="adm-checks adm-checks-row">
          <legend className="sr-only">{t('admin.bills.signupRules.reviewRiskLevels')}</legend>
          {RADAR_RISK_LEVELS.filter(level => level !== 'normal').map(level => (
            <Checkbox
              key={level}
              checked={form.reviewRiskLevels.includes(level)}
              onChange={on => toggleLevel(level, on)}
            >
              {t(RISK[level])}
            </Checkbox>
          ))}
        </fieldset>
      </Card>
      <SaveBar
        dirty={dirty}
        onCancel={() => {
          setProblems([])
          if (saved) setForm(saved)
        }}
        label={t('admin.bills.signupRules.save')}
        note={t('admin.bills.rules.unsaved', { count: saved ? signupChanges(form, saved) : 0 })}
      />
      {asking && (
        <ReasonDialog
          title={t('admin.bills.signupRules.confirmTitle')}
          description={t(
            botCheckOff ? 'admin.bills.signupRules.confirmBotCheckOff' : 'admin.bills.signupRules.confirmText',
          )}
          danger={botCheckOff}
          submit={t('admin.bills.signupRules.save')}
          run={async reason => {
            const next = (await runAdmin('signup.setRules', { rules: asking, reason })) as unknown as SelfServeData
            setQueryData<SelfServeData | undefined>(SELF_SERVE, next, KEPT)
            await refreshQuery(SUMMARY)
            return t('admin.bills.signupRules.saved')
          }}
          notify={notify}
          onClose={() => setAsking(null)}
        />
      )}
    </form>
  )
}

// ---- Billing rules ----

/** Each rule's plain label and its detail behind the (?). */
const RULE_LABELS: Record<RuleField, [MessageKey, MessageKey]> = {
  workspaceMonthlyCents: [
    msg('admin.bills.rules.field.workspaceMonthlyCents'),
    msg('admin.bills.rules.field.workspaceMonthlyCents.help'),
  ],
  workspaceYearlyCents: [
    msg('admin.bills.rules.field.workspaceYearlyCents'),
    msg('admin.bills.rules.field.workspaceYearlyCents.help'),
  ],
  partnerMonthlyCents: [
    msg('admin.bills.rules.field.partnerMonthlyCents'),
    msg('admin.bills.rules.field.partnerMonthlyCents.help'),
  ],
  partnerYearlyCents: [
    msg('admin.bills.rules.field.partnerYearlyCents'),
    msg('admin.bills.rules.field.partnerYearlyCents.help'),
  ],
  trialDays: [msg('admin.bills.rules.field.trialDays'), msg('admin.bills.rules.field.trialDays.help')],
  includedStandardSeconds: [
    msg('admin.bills.rules.field.includedStandardSeconds'),
    msg('admin.bills.rules.field.includedStandardSeconds.help'),
  ],
  balanceBufferMicros: [
    msg('admin.bills.rules.field.balanceBufferMicros'),
    msg('admin.bills.rules.field.balanceBufferMicros.help'),
  ],
  concurrentCallsBase: [
    msg('admin.bills.rules.field.concurrentCallsBase'),
    msg('admin.bills.rules.field.concurrentCallsBase.help'),
  ],
  concurrentCallsPerWorkspace: [
    msg('admin.bills.rules.field.concurrentCallsPerWorkspace'),
    msg('admin.bills.rules.field.concurrentCallsPerWorkspace.help'),
  ],
  concurrentCallsMaxPerWorkspace: [
    msg('admin.bills.rules.field.concurrentCallsMaxPerWorkspace'),
    msg('admin.bills.rules.field.concurrentCallsMaxPerWorkspace.help'),
  ],
  extraCallCents: [msg('admin.bills.rules.field.extraCallCents'), msg('admin.bills.rules.field.extraCallCents.help')],
  trialConcurrentCalls: [
    msg('admin.bills.rules.field.trialConcurrentCalls'),
    msg('admin.bills.rules.field.trialConcurrentCalls.help'),
  ],
  billedTransferCapSeconds: [
    msg('admin.bills.rules.field.billedTransferCapSeconds'),
    msg('admin.bills.rules.field.billedTransferCapSeconds.help'),
  ],
  callLimitGraceSeconds: [
    msg('admin.bills.rules.field.callLimitGraceSeconds'),
    msg('admin.bills.rules.field.callLimitGraceSeconds.help'),
  ],
  extraNumberCents: [
    msg('admin.bills.rules.field.extraNumberCents'),
    msg('admin.bills.rules.field.extraNumberCents.help'),
  ],
  rechargeCapPerWorkspaceCents: [
    msg('admin.bills.rules.field.rechargeCapPerWorkspaceCents'),
    msg('admin.bills.rules.field.rechargeCapPerWorkspaceCents.help'),
  ],
}

const GROUP_TITLES: Record<RuleGroupId, [MessageKey, MessageKey]> = {
  plans: [msg('admin.bills.rules.group.plans'), msg('admin.bills.rules.group.plans.text')],
  minutes: [msg('admin.bills.rules.group.minutes'), msg('admin.bills.rules.group.minutes.text')],
  trial: [msg('admin.bills.rules.group.trial'), msg('admin.bills.rules.group.trial.text')],
  concurrency: [msg('admin.bills.rules.group.concurrency'), msg('admin.bills.rules.group.concurrency.text')],
  limits: [msg('admin.bills.rules.group.limits'), msg('admin.bills.rules.group.limits.text')],
}

const LEVEL_NAMES: Record<string, MessageKey> = {
  standard: msg('admin.bills.rules.levelName.standard'),
  premium: msg('admin.bills.rules.levelName.premium'),
  ultra: msg('admin.bills.rules.levelName.ultra'),
}

function RulesCard({ notify }: { notify: Notify }) {
  const t = useT()
  const query = useQuery(RULES, loadRules, KEPT)
  const data = query.data
  const saved = useMemo(() => (data ? rulesForm(data.effective) : null), [data])
  const defaults = useMemo(() => (data ? rulesForm(data.defaults) : null), [data])
  const [form, setForm] = useState<RulesForm>({})
  const [problems, setProblems] = useState<string[]>([])
  const [asking, setAsking] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    if (saved) setForm(saved)
  }, [saved])
  const changes = saved ? changedFields(form, saved).length : 0
  const dirty = changes > 0
  // Asked of Stripe only while the confirm dialog turns tax on, never with the rules (security review of #1105, N-1).
  const turningTaxOn = !!asking && !!saved && saved[TAX_FIELD] !== 'on' && form[TAX_FIELD] === 'on'
  const taxAddress = useQuery(turningTaxOn ? TAX_ADDRESS : null, loadTaxAddress)

  function save(e: FormEvent) {
    e.preventDefault()
    if (!data) return
    const parsed = rulesFromForm(form, data.defaults)
    setProblems(parsed.problems)
    if ('rules' in parsed) setAsking(parsed.rules)
  }
  if (!data || !defaults)
    return (
      <Card title={t('admin.bills.rules.title')} className="adm-detail">
        <Loading
          what={t('admin.bills.rules.title')}
          loading
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<SkeletonRows rows={4} columns={2} />}
        />
      </Card>
    )
  const own = customFields(form, defaults).length
  const field = (key: string, label: string, help: string, fallbackText?: string) => (
    <NumberField
      key={key}
      id={`adm-rule-${key}`}
      label={label}
      help={help}
      value={form[key] ?? ''}
      fallback={defaults[key] ?? ''}
      fallbackText={fallbackText ?? defaultText(key, defaults[key] ?? '')}
      unit={ruleUnit(key)}
      blankIsNone={blankIsNone(key)}
      error={problems.includes(key) ? t('admin.bills.rules.notANumber') : null}
      onChange={value => setForm(f => ({ ...f, [key]: value }))}
    />
  )
  const ruleField = (key: RuleField) => {
    const floor = planFloorText(key, data.minPlanCents)
    return field(key, t(RULE_LABELS[key][0]), floor ? `${t(RULE_LABELS[key][1])} ${floor}` : t(RULE_LABELS[key][1]))
  }
  const minPrice =
    data.minMicrosPerMinute > 0
      ? ` ${t('admin.bills.rules.minPrice', { amount: rateOfMicros(data.minMicrosPerMinute) })}`
      : ''
  return (
    <form onSubmit={save} onKeyDown={e => onSaveKey(e, dirty)} className="adm-rules">
      <p className="adm-lede">
        {t('admin.bills.rules.lede', { count: own })}
        <HelpTip text={t('admin.bills.rules.description')} />
      </p>
      {data.problems.length > 0 && (
        <Note tone="warning">{t('admin.bills.rules.ignored', { fields: data.problems.join(', ') })}</Note>
      )}
      {RULE_GROUPS.map(group => {
        const [title, text] = GROUP_TITLES[group.id]
        return (
          <Card
            key={group.id}
            id={`adm-rules-${group.id}`}
            title={t(title)}
            description={t(text)}
            className="adm-detail"
          >
            {group.id === 'minutes' && (
              <div className="adm-rules-levels">
                {Object.entries(data.defaults.levels).map(([level, fallback]) => {
                  const name = LEVEL_NAMES[level] ? t(LEVEL_NAMES[level]) : level
                  return (
                    <div key={level} className="adm-rules-grid">
                      {field(
                        `levels.${level}.price`,
                        t('admin.bills.rules.levelPrice', { level: name }),
                        `${t('admin.bills.rules.levelPrice.help', { level: name })}${minPrice}`,
                        rateOfMicros(fallback.microsPerMinute),
                      )}
                      {field(
                        `levels.${level}.factor`,
                        t('admin.bills.rules.levelFactor', { level: name }),
                        t('admin.bills.rules.levelFactor.help', { level: name }),
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            <div className="adm-rules-grid">{group.fields.map(key => ruleField(key))}</div>
          </Card>
        )
      })}
      <Card id="adm-rules-tax" title={t('admin.bills.rules.group.tax')} className="adm-detail">
        <div className="swrow adm-swrow-first">
          <div>
            <b>
              {t('admin.bills.rules.automaticTax')}
              <HelpTip text={t('admin.bills.rules.automaticTax.help')} />
            </b>
            <span className="help">{t('admin.bills.rules.automaticTax.short')}</span>
          </div>
          <Switch
            on={form[TAX_FIELD] === 'on'}
            onChange={on => setForm(f => ({ ...f, [TAX_FIELD]: on ? 'on' : 'off' }))}
            label={t('admin.bills.rules.automaticTax')}
          />
        </div>
      </Card>
      <SaveBar
        dirty={dirty}
        onCancel={() => {
          setProblems([])
          if (saved) setForm(saved)
        }}
        label={t('admin.bills.rules.save')}
        note={t('admin.bills.rules.unsaved', { count: changes })}
      />
      {asking && (
        <ReasonDialog
          title={t('admin.bills.rules.confirmTitle')}
          description={t('admin.bills.rules.confirmText')}
          submit={t('admin.bills.rules.save')}
          run={async reason => {
            const next = (await runAdmin('billingRules.set', { rules: asking, reason }).catch(err => {
              if ((err as { code?: string }).code !== PLAN_PRICE_FLOOR) throw err
              throw new Error(t('admin.bills.rules.planFloor', { amount: usdOfCents(data?.minPlanCents ?? 0) }))
            })) as unknown as BillingRulesData
            setQueryData<BillingRulesData | undefined>(RULES, next, KEPT)
            await refreshQuery(SUMMARY)
            return t('admin.bills.rules.saved')
          }}
          notify={notify}
          onClose={() => setAsking(null)}
        >
          {/* The switch reaches running subscriptions: what that means, before the admin confirms (review #1105, M-1). */}
          {taxChange(form, saved, taxAddress.error ? null : taxAddress.data, t)}
        </ReasonDialog>
      )}
    </form>
  )
}

/**
 * The confirm dialog's note when the Stripe Tax switch changes; null when it does not. `missing`: the count of paying
 * customers without a billing address (undefined while it is asked for, null when it is not known).
 */
export function taxChange(
  form: RulesForm,
  saved: RulesForm | null,
  missing: number | null | undefined,
  t: ReturnType<typeof useT>,
) {
  if (!saved || form[TAX_FIELD] === saved[TAX_FIELD]) return null
  if (form[TAX_FIELD] !== 'on') return <Note>{t('admin.bills.rules.automaticTax.offConfirm')}</Note>
  return (
    <Note>
      {t('admin.bills.rules.automaticTax.onConfirm')}
      {missing === undefined && <> {t('admin.bills.rules.automaticTax.onConfirmCounting')}</>}
      {typeof missing === 'number' && <> {t('admin.bills.rules.automaticTax.onConfirmMissing', { count: missing })}</>}
    </Note>
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
  // The extra calls at the same time the owner bought (LIN-450), over the bill's workspaces.
  const extraCalls = bill.workspaces.reduce((sum, w) => sum + w.extraCalls, 0)
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
          <Fact label={t('admin.bills.fact.risk')}>
            <RiskBadge level={bill.cardRiskLevel} />
            <span className="adm-sub">{t('admin.bills.fact.riskHelp')}</span>
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
            {extraCalls > 0 && (
              <span className="adm-sub">{t('admin.bills.fact.concurrencyExtra', { count: extraCalls })}</span>
            )}
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
                  <th scope="col" className="adm-num">
                    {t('admin.bills.usage.extraCalls')}
                  </th>
                  <th scope="col" className="adm-num">
                    {t('admin.bills.usage.busyCallers')} <HelpTip text={t('admin.bills.usage.busyCallersHelp')} />
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
                      <td className="adm-num" data-label={t('admin.bills.usage.extraCalls')}>
                        {w.extraCalls ? t('admin.bills.usage.extraCallsValue', { count: w.extraCalls }) : EMPTY}
                      </td>
                      <td className="adm-num" data-label={t('admin.bills.usage.busyCallers')}>
                        {w.busyCallers ? fmt().number(w.busyCallers) : EMPTY}
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
