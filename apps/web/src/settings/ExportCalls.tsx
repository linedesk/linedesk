// Settings, Export: the calls of a date range as a CSV file (call.export, owners and admins).
import type { CallExportData } from '@linedesk/actions'
import { useState } from 'react'
import { DateInput } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { Field, Section } from './fields.tsx'
import { callAction } from './settings-api.ts'
import './webhooks.css'

type Props = { canEdit: boolean; toast: (text: string) => void }

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ExportCalls({ canEdit, toast }: Props) {
  if (!canEdit)
    return (
      <Section id="st-export" title="Export calls">
        <p className="help">Only admins can export calls.</p>
      </Section>
    )
  return <ExportForm toast={toast} />
}

function ExportForm({ toast }: Pick<Props, 'toast'>) {
  const today = new Date()
  const [from, setFrom] = useState(() => isoDay(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [to, setTo] = useState(() => isoDay(today))
  const [busy, setBusy] = useState(false)
  async function run() {
    setBusy(true)
    try {
      const data = await callAction<CallExportData>('call.export', { from, to })
      download(data.filename, data.csv ?? '')
      toast(
        data.truncated
          ? `Exported the newest ${data.count} calls. Pick a shorter range for the rest.`
          : `Exported ${data.count} call${data.count === 1 ? '' : 's'}.`,
      )
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      id="st-export"
      title="Export calls"
      description="A CSV file with each call's caller, urgency, outcome and summary, for a spreadsheet or your CRM."
    >
      <div className="cf-export">
        <Field id="ex-from" label="From">
          <DateInput id="ex-from" value={from} max={to} onChange={setFrom} />
        </Field>
        <Field id="ex-to" label="To">
          <DateInput id="ex-to" value={to} min={from} onChange={setTo} />
        </Field>
        <Button busy={busy} disabled={busy || !from || !to} onClick={run}>
          {busy ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>
    </Section>
  )
}
