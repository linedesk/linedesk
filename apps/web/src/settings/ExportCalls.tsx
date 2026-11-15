// Settings, Export: the calls of a date range as a CSV file (call.export, owners and admins).
import type { CallExportData } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
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
  const t = useT()
  if (!canEdit)
    return (
      <Section id="st-export" title={t('settings.export.title')}>
        <p className="help">{t('settings.export.onlyAdmins')}</p>
      </Section>
    )
  return <ExportForm toast={toast} />
}

function ExportForm({ toast }: Pick<Props, 'toast'>) {
  const t = useT()
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
          ? t('settings.export.truncated', { count: data.count })
          : t('settings.export.done', { count: data.count }),
      )
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section id="st-export" title={t('settings.export.title')} description={t('settings.export.description')}>
      <div className="cf-export">
        <Field id="ex-from" label={t('settings.export.from')}>
          <DateInput id="ex-from" value={from} max={to} onChange={setFrom} />
        </Field>
        <Field id="ex-to" label={t('settings.export.to')}>
          <DateInput id="ex-to" value={to} min={from} onChange={setTo} />
        </Field>
        <Button busy={busy} disabled={busy || !from || !to} onClick={run}>
          {busy ? t('settings.export.exporting') : t('settings.export.button')}
        </Button>
      </div>
    </Section>
  )
}
