// Server admin › Overview › Needs you (LIN-747): what waits for an admin's hand across the sections, one row each,
// linking to where it is done: bills held for review or owing, Stripe events that failed, partners waiting for
// approval, new workspaces without a real call. Only rows with something in them; the card is gone when nothing waits
// (and while it is read: the server's own health is the "Ready for calls" card above it).
import { useT } from '@linedesk/i18n/react'
import { useQuery } from '../cachedQuery.ts'
import { Card } from '../ui/form.tsx'
import { List } from '../ui/list.tsx'
import { loadAtRisk } from './api.ts'
import { useSummary } from './Billing.tsx'
import { billsHref } from './billingModel.ts'
import { loadPartners, PARTNERS } from './Partners.tsx'
import { stripeEventsHref, workspacesHref } from './route.ts'
import { type Row, StatusRow } from './StatusCard.tsx'
import { useSupportAccess } from '../supportAccess.ts'

/** The at-risk view's own read (Onboarding.tsx AtRisk, 1 day): the row's count is the list its link opens. */
const AT_RISK = 'admin.onboarding.1'

export function NeedsYou() {
  const t = useT()
  const supportAccess = useSupportAccess()
  const summary = useSummary().data
  const partners = useQuery(supportAccess ? null : PARTNERS, loadPartners).data
  const atRisk = useQuery(AT_RISK, () => loadAtRisk(1)).data
  const row = (id: string, label: string, value: string, href: string, urgent = false): Row => ({
    id,
    label,
    state: urgent ? 'failing' : 'partly',
    mark: value,
    value,
    problem: null,
    help: null,
    href,
  })
  const rows: Row[] = []
  if (summary?.held)
    rows.push(
      row(
        'held',
        t('admin.needsYou.held'),
        t('admin.needsYou.count', { count: summary.held }),
        '#admin/billing/review',
        true,
      ),
    )
  const owing = (summary?.bills.past_due ?? 0) + (summary?.bills.suspended ?? 0)
  if (owing)
    rows.push(
      row(
        'owing',
        t('admin.needsYou.owing'),
        t('admin.needsYou.count', { count: owing }),
        billsHref(summary?.bills.past_due ? 'past_due' : 'suspended'),
        true,
      ),
    )
  const failed = (summary?.events.failed ?? 0) + (summary?.events.unhandled ?? 0)
  if (failed)
    rows.push(
      row(
        'stripe',
        t('admin.needsYou.stripe'),
        t('admin.needsYou.count', { count: failed }),
        stripeEventsHref(summary?.events.failed ? 'failed' : 'unhandled'),
        true,
      ),
    )
  const waiting = partners?.partners.filter(p => p.status === 'pending').length ?? 0
  if (waiting)
    rows.push(
      row(
        'partners',
        t('admin.needsYou.partners'),
        t('admin.needsYou.count', { count: waiting }),
        '#admin/partners/waiting',
      ),
    )
  const stuck = atRisk?.workspaces.length ?? 0
  if (stuck)
    rows.push(
      row(
        'at-risk',
        t('admin.needsYou.atRisk'),
        t('admin.needsYou.count', { count: stuck }),
        workspacesHref('at-risk'),
      ),
    )
  if (!rows.length) return null
  return (
    <Card title={t('admin.needsYou.title')}>
      <List label={t('admin.needsYou.title')}>
        {rows.map(r => (
          <StatusRow key={r.id} row={r} link />
        ))}
      </List>
    </Card>
  )
}
