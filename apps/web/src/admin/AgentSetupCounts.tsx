// Server admin › Onboarding › Agent setup (LIN-657): which AI agent people pick when they make a setup link, and how
// many of those agents connected (called setup_status at least once). Counts only, from our own table
// (apps/api/src/agent-setup-counts.ts); the range is the funnel's, in weeks.
import { useFormat, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { AgentMark, agentLabel } from '../onboarding/AgentPicker.tsx'
import { Select } from '../ui/controls.tsx'
import { Card } from '../ui/form.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { Icon } from '../ui/kit.tsx'
import { type AgentSetupCountRow, loadAgentSetupCounts, type SetupLinkKind } from './api.ts'

const RANGES = ['4', '8', '12', '26'] as const
type Range = (typeof RANGES)[number]
const KINDS = ['all', 'install', 'workspace', 'partner'] as const satisfies readonly SetupLinkKind[]

function ClientName({ client }: { client: AgentSetupCountRow['client'] }) {
  const t = useT()
  if (client === 'none')
    return (
      <span className="adm-agent-name">
        <Icon name="plug" size={16} className="as-agent-mark is-muted" />
        {t('admin.agentSetupCounts.noClient')}
      </span>
    )
  return (
    <span className="adm-agent-name">
      <AgentMark client={client} />
      {agentLabel(client, t)}
    </span>
  )
}

export function AgentSetupCounts() {
  const t = useT()
  const format = useFormat()
  const [range, setRange] = useState<Range>('8')
  const [kind, setKind] = useState<SetupLinkKind>('all')
  const query = useQuery(`admin.agentSetupCounts.${range}.${kind}`, () => loadAgentSetupCounts(Number(range), kind))
  const data = query.data
  const pct = (n: number, of: number) =>
    of > 0 ? format.number(n / of, { style: 'percent', maximumFractionDigits: 0 }) : null
  const kindLabels: Record<SetupLinkKind, string> = {
    all: t('admin.agentSetupCounts.kind.all'),
    install: t('admin.agentSetupCounts.kind.install'),
    workspace: t('admin.agentSetupCounts.kind.workspace'),
    partner: t('admin.agentSetupCounts.kind.partner'),
  }
  return (
    <Card
      title={t('admin.agentSetupCounts.title')}
      description={t('admin.agentSetupCounts.description')}
      help={t('admin.agentSetupCounts.help')}
      actions={
        <div className="adm-card-filters">
          <Select
            size="sm"
            align="end"
            label={t('admin.agentSetupCounts.kindLabel')}
            value={kind}
            onChange={setKind}
            options={KINDS.map(k => ({ value: k, label: kindLabels[k] }))}
          />
          <Select
            size="sm"
            align="end"
            label={t('admin.funnel.range')}
            value={range}
            onChange={setRange}
            options={RANGES.map(r => ({ value: r, label: t('admin.funnel.lastWeeks', { weeks: Number(r) }) }))}
          />
        </div>
      }
    >
      <Loading
        what={t('admin.agentSetupCounts.title')}
        loading={!data}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonRows rows={4} columns={4} className="adm-sk-rows" />}
      >
        {data &&
          (data.rows.length === 0 ? (
            <p className="adm-empty">{t('admin.agentSetupCounts.empty')}</p>
          ) : (
            <div className="adm-scroll">
              <table className="adm-table adm-funnel-table">
                <thead>
                  <tr>
                    <th scope="col">{t('admin.agentSetupCounts.client')}</th>
                    <th scope="col" className="adm-num">
                      {t('admin.agentSetupCounts.made')}
                    </th>
                    <th scope="col" className="adm-num">
                      {t('admin.agentSetupCounts.connected')}
                    </th>
                    <th scope="col" className="adm-num">
                      {t('admin.agentSetupCounts.share')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(row => {
                    const rate = pct(row.connected, row.made)
                    return (
                      <tr key={row.client}>
                        <th scope="row">
                          <ClientName client={row.client} />
                        </th>
                        <td className="adm-num">{format.number(row.made)}</td>
                        <td className="adm-num">
                          {format.number(row.connected)}
                          {rate && <span className="adm-funnel-pct">{rate}</span>}
                        </td>
                        <td className="adm-num">{pct(row.made, data.total.made)}</td>
                      </tr>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">{t('admin.agentSetupCounts.total')}</th>
                    <td className="adm-num">{format.number(data.total.made)}</td>
                    <td className="adm-num">
                      {format.number(data.total.connected)}
                      {pct(data.total.connected, data.total.made) && (
                        <span className="adm-funnel-pct">{pct(data.total.connected, data.total.made)}</span>
                      )}
                    </td>
                    <td className="adm-num" />
                  </tr>
                </tfoot>
              </table>
            </div>
          ))}
      </Loading>
    </Card>
  )
}
