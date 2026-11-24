// Server admin › Overview › Funnel (LIN-425): how far the workspaces that signed up each week got, counted from our
// own tables (no tracker in the app). A workspace counts in the week it signed up (UTC, weeks start on Monday) and in
// every step it reached since, whenever that was:
//   signed up   the signup milestone, or the workspace's creation for one older than the milestones;
//   set up      forwarding works on one of its numbers (#746: a check verified it, the forwarding_verified milestone),
//               or a real caller reached it, which only a working number allows;
//   first call  a real caller's call (isRealCall: incoming over the phone, not the business's own phones, not spam);
//   paid        its bill paid an invoice above zero (plan fee, recharge or top-up), or the bill is active.
// Left out: disabled workspaces and those owned by an instance admin (the operator's own and test workspaces).
import type { Tx } from '@linedesk/db'
import { sql } from 'drizzle-orm'

/** The ranges the page offers, in weeks; anything else is the default. */
export const FUNNEL_WEEKS = [4, 8, 12, 26] as const
export const FUNNEL_WEEKS_DEFAULT = 8

export type FunnelCounts = { signed_up: number; set_up: number; first_call: number; paid: number }
/** One sign-up week: its Monday (UTC, YYYY-MM-DD) and the counts of the workspaces that signed up in it. */
export type FunnelWeek = FunnelCounts & { week_start: string }
export type Funnel = { weeks: number; rows: FunnelWeek[]; total: FunnelCounts }

/** `weeks` of GET /v1/admin/funnel: one of FUNNEL_WEEKS, else the default. */
export function funnelWeeks(value: string | undefined): number {
  const n = Number(value)
  return (FUNNEL_WEEKS as readonly number[]).includes(n) ? n : FUNNEL_WEEKS_DEFAULT
}

const realCallIn = (workspaceId: unknown) => sql`exists (select 1 from calls c where c.workspace_id = ${workspaceId}
  and c.source = 'phone' and c.direction = 'in' and c.from_own_number = false and c.outcome is distinct from 'spam')`

/** The funnel of the last `weeks` sign-up weeks, the current one included, newest first. */
export async function adminFunnel(tx: Tx, weeks: number, now = new Date().toISOString()): Promise<Funnel> {
  const { rows } = await tx.execute<FunnelWeek>(sql`
    with bounds as (
      select date_trunc('week', ${now}::timestamptz at time zone 'utc') as this_week
    ), series as (
      select generate_series(this_week - make_interval(weeks => ${weeks - 1}), this_week, interval '1 week') as week
      from bounds
    ), ws as (
      select o.id, o.billing_account_id,
        date_trunc('week', coalesce(su.at at time zone 'utc', o.created_at)) as week
      from organization o
        left join setup_events su on su.workspace_id = o.id and su.event = 'signup'
      where o.disabled_at is null
        and not exists (select 1 from member m join "user" u on u.id = m.user_id
          where m.organization_id = o.id and m.role = 'owner' and u.instance_admin)
    ), facts as (
      select ws.week,
        (exists (select 1 from setup_events e where e.workspace_id = ws.id and e.event = 'first_real_call')
          or ${realCallIn(sql.raw('ws.id'))}) as first_call,
        (exists (select 1 from setup_events e where e.workspace_id = ws.id and e.event = 'forwarding_verified')
          or exists (select 1 from phone_numbers p where p.workspace_id = ws.id and p.verified_at is not null)) as verified,
        (ws.billing_account_id is not null and (
          exists (select 1 from billing_invoices i where i.billing_account_id = ws.billing_account_id
            and i.status = 'paid' and i.total_cents > 0)
          or exists (select 1 from billing_accounts b where b.id = ws.billing_account_id and b.status = 'active'))) as paid
      from ws, bounds
      where ws.week >= bounds.this_week - make_interval(weeks => ${weeks - 1})
    )
    select to_char(s.week, 'YYYY-MM-DD') as week_start,
      count(f.week)::int as signed_up,
      (count(*) filter (where f.verified or f.first_call))::int as set_up,
      (count(*) filter (where f.first_call))::int as first_call,
      (count(*) filter (where f.paid))::int as paid
    from series s left join facts f on f.week = s.week
    group by s.week
    order by s.week desc`)
  const total = rows.reduce<FunnelCounts>(
    (sum, r) => ({
      signed_up: sum.signed_up + r.signed_up,
      set_up: sum.set_up + r.set_up,
      first_call: sum.first_call + r.first_call,
      paid: sum.paid + r.paid,
    }),
    { signed_up: 0, set_up: 0, first_call: 0, paid: 0 },
  )
  return { weeks, rows, total }
}
