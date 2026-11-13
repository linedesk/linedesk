// Onboarding: how new workspaces get to their first real call. Whether they get setup emails (off by default, so a
// self-hosted install sends none), and the workspaces at risk: signed up a while ago and no real call has reached
// their assistant yet. Each shows the setup milestones it reached and when, so we see where it stopped, and the owner to write to. Read-only: hands-on
// help comes from partners, not from us.
import type { SetupEmailsData } from '@linedesk/actions'
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Select, Switch } from '../ui/controls.tsx'
import { Card } from '../ui/form.tsx'
import { LoadProblem, SkeletonRows } from '../ui/LoadStates.tsx'
import { type AtRiskWorkspace, loadAtRisk, runAdmin } from './api.ts'
import { day, when } from './parts.tsx'

const SETUP_EMAILS = 'admin.setupEmails'
const loadSetupEmails = async () => (await runAdmin('setupEmails.get', {})) as SetupEmailsData

/**
 * The one line under the switch while email is not connected (only the log, or nowhere): no setup email goes out
 * then, so it cannot be turned on; one already on can still be turned off.
 */
function notConnectedLine(on: boolean): string {
  return on
    ? 'Email is not connected under Providers: none go out until it is.'
    : 'Connect email under Providers first: until then no setup email can reach anyone.'
}

function SetupEmails() {
  const query = useQuery(SETUP_EMAILS, loadSetupEmails)
  const [problem, setProblem] = useState<string | null>(null)
  const data = query.data
  const on = data?.on ?? false
  const note = data && !data.emailConnected ? notConnectedLine(on) : null
  async function change(next: boolean) {
    if (!data) return
    setProblem(null)
    setQueryData<SetupEmailsData | undefined>(SETUP_EMAILS, { ...data, on: next })
    try {
      await runAdmin('setupEmails.set', { on: next })
    } catch (e) {
      setQueryData<SetupEmailsData | undefined>(SETUP_EMAILS, { ...data, on: !next })
      setProblem(e instanceof Error ? e.message : 'Could not change setup emails.')
    }
  }
  const partner = data?.partnerDirectoryUrl ? ' (with a link to the partner directory)' : ''
  return (
    <Card
      title="Setup emails"
      help={`To the owners of new workspaces: what is left a few hours after sign-up, the next step on day 1 and day 3${partner}, their first real call, and a summary after the first week. They stop once a real call came in, each goes out once, and owners can turn them off.`}
    >
      <div className="swrow">
        <div>
          <b>Send setup emails</b>
          {note && <span className="help">{note}</span>}
        </div>
        <Switch
          on={on}
          onChange={v => void change(v)}
          label="Send setup emails"
          disabled={!data || (!on && !data.emailConnected)}
        />
      </div>
      {problem && (
        <p className="k-field-msg" role="alert">
          {problem}
        </p>
      )}
    </Card>
  )
}

/**
 * Setup milestones in the order a business reaches them (setup_events). The number and forwarding ones are the go-live
 * checklist's first steps ("Connect your number", "Turn on call forwarding"). number_connected comes with #488 (LIN-85).
 */
const milestoneLabels: Record<string, string> = {
  signup: 'Signed up',
  business_found: 'Business found',
  assistant_heard: 'Heard the assistant',
  mobile_added: 'Mobile added',
  number_connected: 'Number connected',
  forwarding_instructions_shown: 'Forwarding steps shown',
  forwarding_verified: 'Forwarding verified',
  onboarding_skipped: 'Skipped onboarding',
  onboarding_done: 'Finished onboarding',
}
const emailLabels: Record<string, string> = {
  setup_day0: 'Day 0',
  setup_day1: 'Day 1',
  setup_day3: 'Day 3',
  first_call: 'First call',
  week_summary: 'Week',
}

/** The milestones reached, oldest first. */
const reached = (w: AtRiskWorkspace) =>
  Object.entries(w.milestones)
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([event, at]) => ({ label: milestoneLabels[event] ?? event, at }))

const DAYS = ['1', '3', '7', '14'] as const

/** An empty list: either every workspace old enough had a real call, or none is old enough to judge yet (a new install). */
function emptyText(oldEnough: number, days: string) {
  const ago = `more than ${days} ${days === '1' ? 'day' : 'days'} ago`
  if (oldEnough === 0) return `No workspace signed up ${ago} yet, so there is nobody to judge.`
  if (oldEnough === 1) return `Nobody. The one workspace that signed up ${ago} has had a real call.`
  return `Nobody. All ${oldEnough} workspaces that signed up ${ago} have had a real call.`
}

function AtRisk() {
  const [days, setDays] = useState<(typeof DAYS)[number]>('1')
  const key = `admin.onboarding.${days}`
  const query = useQuery(key, () => loadAtRisk(Number(days)))
  const rows = query.data?.workspaces ?? null
  return (
    <Card
      title="At risk"
      description="Signed up a while ago, no real call yet. Where each one stopped."
      actions={
        <Select
          size="sm"
          align="end"
          label="Signed up more than"
          value={days}
          onChange={setDays}
          options={DAYS.map(d => ({ value: d, label: `More than ${d} ${d === '1' ? 'day' : 'days'} ago` }))}
        />
      }
    >
      {!rows ? (
        query.error ? (
          <LoadProblem what="the list" message={query.error} onRetry={() => void query.reload()} />
        ) : (
          <SkeletonRows label="Loading" />
        )
      ) : rows.length === 0 ? (
        <p className="adm-notice">{emptyText(query.data?.oldEnough ?? 0, days)}</p>
      ) : (
        <div className="adm-scroll">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Signed up</th>
                <th scope="col">Stopped after</th>
                <th scope="col">Setup emails</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(w => {
                const steps = reached(w)
                const last = steps.at(-1)
                return (
                  <tr key={w.id}>
                    <th scope="row">
                      <a href={`#admin/workspaces/${encodeURIComponent(w.id)}`}>{w.name}</a>
                      <span className="adm-sub">{w.owner_email ?? 'No owner'}</span>
                    </th>
                    <td>{day(w.signed_up_at)}</td>
                    <td>
                      {last ? last.label : 'Signed up'}
                      {last && <span className="adm-sub">{when(last.at)}</span>}
                      {steps.length > 1 && (
                        <details className="adm-steps">
                          <summary>All steps</summary>
                          <ol>
                            {steps.map(s => (
                              <li key={s.label}>
                                {s.label} <span className="adm-sub-inline">{when(s.at)}</span>
                              </li>
                            ))}
                          </ol>
                        </details>
                      )}
                    </td>
                    <td>
                      {Object.keys(w.emails).length
                        ? Object.entries(w.emails)
                            .sort(([, a], [, b]) => a.localeCompare(b))
                            .map(([kind, at]) => (
                              <span key={kind} className="adm-line" title={when(at)}>
                                {emailLabels[kind] ?? kind}
                              </span>
                            ))
                        : 'None'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

export function Onboarding() {
  return (
    <>
      <SetupEmails />
      <AtRisk />
    </>
  )
}
