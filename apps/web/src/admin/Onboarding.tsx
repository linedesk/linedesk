// Onboarding: how new workspaces get to their first real call. Whether they get setup emails (off by default, so a
// self-hosted install sends none), and the workspaces at risk: added a while ago and no real call has reached
// their assistant yet. Each shows the setup milestones it reached and when, so we see where it stopped, and the owner to write to. Read-only: hands-on
// help comes from partners, not from us.
import type { SetupEmailsData } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Select, Switch } from '../ui/controls.tsx'
import { Card } from '../ui/form.tsx'
import { Loading, Skeleton, SkeletonRows } from '../ui/LoadStates.tsx'
import { type AtRiskWorkspace, loadAtRisk, runAdmin } from './api.ts'
import { AgentSetupCounts } from './AgentSetupCounts.tsx'
import { Funnel } from './Funnel.tsx'
import { day, when } from './parts.tsx'

const SETUP_EMAILS = 'admin.setupEmails'
const loadSetupEmails = async () => (await runAdmin('setupEmails.get', {})) as SetupEmailsData

/**
 * The one line under the switch while email is not connected (only the log, or nowhere): no setup email goes out
 * then, so it cannot be turned on; one already on can still be turned off.
 */
function notConnectedLine(on: boolean): MessageKey {
  return on ? msg('admin.onboarding.emailNotConnectedOn') : msg('admin.onboarding.emailNotConnectedOff')
}

function SetupEmails() {
  const t = useT()
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
      setProblem(e instanceof Error ? e.message : t('admin.onboarding.setupEmailsFailed'))
    }
  }
  return (
    <Card
      title={t('admin.onboarding.setupEmails')}
      help={t('admin.onboarding.setupEmailsHelp', { partner: data?.partnerDirectoryUrl ? 'yes' : 'no' })}
    >
      <div className="swrow">
        <div>
          <b>{t('admin.onboarding.sendSetupEmails')}</b>
          {note && <span className="help">{t(note)}</span>}
        </div>
        <Loading
          what={t('admin.onboarding.setupEmails')}
          loading={!data}
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<Skeleton width={34} height={20} className="sk-round" />}
        >
          <Switch
            on={on}
            onChange={v => void change(v)}
            label={t('admin.onboarding.sendSetupEmails')}
            disabled={!data || (!on && !data.emailConnected)}
          />
        </Loading>
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
const milestoneLabels: Record<string, MessageKey> = {
  signup: msg('admin.onboarding.milestone.signup'),
  business_found: msg('admin.onboarding.milestone.businessFound'),
  assistant_heard: msg('admin.onboarding.milestone.assistantHeard'),
  mobile_added: msg('admin.onboarding.milestone.mobileAdded'),
  number_connected: msg('admin.onboarding.milestone.numberConnected'),
  forwarding_instructions_shown: msg('admin.onboarding.milestone.forwardingShown'),
  forwarding_verified: msg('admin.onboarding.milestone.forwardingVerified'),
  onboarding_skipped: msg('admin.onboarding.milestone.skipped'),
  onboarding_done: msg('admin.onboarding.milestone.done'),
}
const emailLabels: Record<string, MessageKey> = {
  setup_day0: msg('admin.onboarding.email.day0'),
  setup_day1: msg('admin.onboarding.email.day1'),
  setup_day3: msg('admin.onboarding.email.day3'),
  first_call: msg('admin.onboarding.email.firstCall'),
  week_summary: msg('admin.onboarding.email.week'),
}

/** The milestones reached, oldest first. */
const reached = (w: AtRiskWorkspace, t: ReturnType<typeof useT>) =>
  Object.entries(w.milestones)
    .sort(([, a], [, b]) => a.localeCompare(b))
    .map(([event, at]) => {
      const key = milestoneLabels[event]
      return { label: key ? t(key) : event, at }
    })

const DAYS = ['1', '3', '7', '14'] as const

/** An empty list: either every workspace old enough had a real call, or none is old enough to judge yet (a new install). */
function emptyText(t: ReturnType<typeof useT>, oldEnough: number, days: string) {
  return t('admin.onboarding.empty', { count: oldEnough, days: Number(days) })
}

function AtRisk() {
  const t = useT()
  const [days, setDays] = useState<(typeof DAYS)[number]>('1')
  const key = `admin.onboarding.${days}`
  const query = useQuery(key, () => loadAtRisk(Number(days)))
  const rows = query.data?.workspaces ?? null
  return (
    <Card
      title={t('admin.onboarding.atRisk')}
      description={t('admin.onboarding.atRiskDescription')}
      actions={
        <Select
          size="sm"
          align="end"
          label={t('admin.onboarding.addedMoreThan')}
          value={days}
          onChange={setDays}
          options={DAYS.map(d => ({ value: d, label: t('admin.onboarding.moreThanDays', { days: Number(d) }) }))}
        />
      }
    >
      {!rows ? (
        <Loading
          what={t('admin.onboarding.listWhat')}
          loading
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<SkeletonRows rows={6} columns={4} className="adm-sk-rows" />}
        />
      ) : rows.length === 0 ? (
        <p className="adm-empty">{emptyText(t, query.data?.oldEnough ?? 0, days)}</p>
      ) : (
        <div className="adm-scroll">
          <table className="adm-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.onboarding.column.workspace')}</th>
                <th scope="col">{t('admin.onboarding.column.added')}</th>
                <th scope="col">{t('admin.onboarding.column.stoppedAfter')}</th>
                <th scope="col">{t('admin.onboarding.setupEmails')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(w => {
                const steps = reached(w, t)
                const last = steps.at(-1)
                return (
                  <tr key={w.id}>
                    <th scope="row">
                      <a href={`#admin/workspaces/${encodeURIComponent(w.id)}`}>{w.name}</a>
                      <span className="adm-sub">{w.owner_email ?? t('admin.onboarding.noOwner')}</span>
                    </th>
                    <td>{day(w.signed_up_at)}</td>
                    <td>
                      {last ? last.label : t('admin.onboarding.milestone.signup')}
                      {last && <span className="adm-sub">{when(last.at)}</span>}
                      {steps.length > 1 && (
                        <details className="adm-steps">
                          <summary>{t('admin.onboarding.allSteps')}</summary>
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
                                {emailLabels[kind] ? t(emailLabels[kind]) : kind}
                              </span>
                            ))
                        : t('admin.onboarding.noEmails')}
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
      <Funnel />
      <AgentSetupCounts />
      <AtRisk />
      <SetupEmails />
    </>
  )
}
