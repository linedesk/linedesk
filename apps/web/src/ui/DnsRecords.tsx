// The DNS records a partner adds at its DNS host (Partner › Email sender, Partner › Domain): type, name and value in
// full (never cut short: they are copied), each with Copy buttons and a mark once the record is found. The buttons go
// under the value on phones.
import { useT } from '@linedesk/i18n/react'
import { CopyButton } from '../onboarding/Frame.tsx'
import { StatusMark } from './StatusMark.tsx'
import './dns-records.css'

export type DnsRecord = {
  type: string
  name: string
  value: string
  /** MX only. */
  priority?: number | null
  found: boolean
}

export function DnsRecords({ records }: { records: readonly DnsRecord[] }) {
  const t = useT()
  return (
    <ul className="dns-records" aria-label={t('team.partner.dns.records')}>
      {records.map(r => (
        <li key={`${r.type}:${r.name}:${r.value}`} className="dns-record">
          <div className="dns-record-text">
            <span className="dns-record-head">
              {r.type} · <code>{r.name}</code>
              {r.priority != null && ` · ${t('team.partner.dns.priority', { priority: r.priority })}`}
              {r.found && <StatusMark state="works" label={t('team.partner.dns.recordFound')} />}
            </span>
            <code className="dns-value">{r.value}</code>
          </div>
          <div className="dns-record-copy">
            <CopyButton text={r.name} label={t('team.partner.dns.copyName')} />
            <CopyButton text={r.value} label={t('team.partner.dns.copyValue')} />
          </div>
        </li>
      ))}
    </ul>
  )
}
