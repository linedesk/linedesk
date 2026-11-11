// Settings, Call details: the workspace's own fields on calls (custom_fields, synced) and the CSV
// export of calls. Fields are added and changed with the server's answer (it checks the cap and the
// options); the export downloads what call.export returns.
import {
  type CallExportData,
  type CustomFieldUpsert,
  customFieldProblem,
  MAX_CHOICES,
  MAX_CUSTOM_FIELDS,
} from '@linedesk/actions'
import type { CustomField, CustomFieldType } from '@linedesk/db/types'
import { type FormEvent, useState } from 'react'
import { useRows } from '../store.tsx'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { Dialog, Input } from '../ui/form.tsx'
import { Badge, Button } from '../ui/kit.tsx'
import { SkeletonRows, useLoadState } from '../ui/LoadStates.tsx'
import { Field, Section, SwitchRow, TextArea } from './fields.tsx'
import { callAction, useWriteAction } from './settings-api.ts'
import './webhooks.css'

type Props = { canEdit: boolean; toast: (text: string) => void }

export const fieldTypeLabel: Record<CustomFieldType, string> = {
  text: 'Text',
  number: 'Number',
  boolean: 'Yes / no',
  choice: 'Choice',
}
const typeOptions: SelectOption<CustomFieldType>[] = (Object.keys(fieldTypeLabel) as CustomFieldType[]).map(value => ({
  value,
  label: fieldTypeLabel[value],
}))

/** The workspace's custom fields in the order they were added. */
export function useCustomFields(): CustomField[] {
  return useRows('custom_fields').sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
}

export function CallDetails({ canEdit, toast }: Props) {
  if (!canEdit)
    return (
      <Section id="st-fields" title="Call details">
        <p className="help">Only owners and admins can change call fields and export calls.</p>
      </Section>
    )
  return (
    <>
      <CustomFields toast={toast} />
      <ExportCalls toast={toast} />
    </>
  )
}

function CustomFields({ toast }: Pick<Props, 'toast'>) {
  const fields = useCustomFields()
  const load = useLoadState('custom_fields')
  const [editing, setEditing] = useState<CustomField | 'new' | null>(null)
  const full = fields.length >= MAX_CUSTOM_FIELDS
  return (
    <Section
      id="st-fields"
      title="Custom fields"
      description="Every call has caller name, callback number, address, job type and urgency. Add what else your business needs."
      help={`The assistant fills these from the conversation after each call; turn on "Ask every caller" to have it ask. Your team can correct them on the call. At most ${MAX_CUSTOM_FIELDS}.`}
      actions={
        <Button
          size="sm"
          icon="plus"
          disabled={full}
          title={full ? `At most ${MAX_CUSTOM_FIELDS} fields` : undefined}
          onClick={() => setEditing('new')}
        >
          Add field
        </Button>
      }
    >
      {load !== 'ready' && fields.length === 0 ? (
        <SkeletonRows label="Loading fields" rows={2} />
      ) : fields.length === 0 ? (
        <p className="help">No custom fields yet.</p>
      ) : (
        <ul className="wh-list">
          {fields.map(f => (
            <FieldRow key={f.id} field={f} onEdit={() => setEditing(f)} toast={toast} />
          ))}
        </ul>
      )}
      {editing && (
        <FieldDialog field={editing === 'new' ? null : editing} onClose={() => setEditing(null)} toast={toast} />
      )}
    </Section>
  )
}

function FieldRow({ field, onEdit, toast }: { field: CustomField; onEdit: () => void; toast: Props['toast'] }) {
  const write = useWriteAction()
  const [busy, setBusy] = useState(false)
  async function remove() {
    if (
      !window.confirm(
        `Remove the field ${field.label}? Calls keep what was filled in, but it is no longer shown or exported.`,
      )
    )
      return
    setBusy(true)
    try {
      await write('customField.delete', { fieldId: field.id })
      toast(`${field.label} removed.`)
    } catch (e) {
      toast((e as Error).message)
      setBusy(false)
    }
  }
  const sub = [fieldTypeLabel[field.type], field.type === 'choice' ? field.options.join(', ') : null, field.instruction]
    .filter(Boolean)
    .join(' · ')
  return (
    <li className="wh-row">
      <div className="wh-head">
        <span className="wh-main">
          <b>{field.label}</b>
          <span className="wh-sub">{sub}</span>
        </span>
        {field.ask_caller && <Badge>Asked on calls</Badge>}
        <Button size="sm" variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={remove}>
          Remove
        </Button>
      </div>
    </li>
  )
}

function FieldDialog({
  field,
  onClose,
  toast,
}: {
  field: CustomField | null
  onClose: () => void
  toast: Props['toast']
}) {
  const write = useWriteAction()
  const [label, setLabel] = useState(field?.label ?? '')
  const [type, setType] = useState<CustomFieldType>(field?.type ?? 'text')
  const [options, setOptions] = useState(field?.options.join(', ') ?? '')
  const [askCaller, setAskCaller] = useState(field?.ask_caller ?? false)
  const [instruction, setInstruction] = useState(field?.instruction ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const input: CustomFieldUpsert = {
      ...(field ? { fieldId: field.id } : {}),
      label: label.trim(),
      type,
      options:
        type === 'choice'
          ? options
              .split(',')
              .map(o => o.trim())
              .filter(Boolean)
          : [],
      askCaller,
      instruction: instruction.trim() || null,
    }
    const problem =
      customFieldProblem(input) ??
      ((input.options?.length ?? 0) > MAX_CHOICES ? `At most ${MAX_CHOICES} options` : null)
    if (problem) return setError(problem)
    setSaving(true)
    setError(null)
    try {
      await write('customField.upsert', input)
      toast(field ? `${input.label} saved.` : `${input.label} added.`)
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={field ? 'Edit field' : 'Add field'}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving || !label.trim()}>
            {field ? 'Save' : saving ? 'Adding…' : 'Add'}
          </Button>
        </>
      }
    >
      <Field id="cf-label" label="Label" error={error}>
        <Input
          id="cf-label"
          value={label}
          maxLength={60}
          placeholder="Home size"
          onChange={e => setLabel(e.target.value)}
        />
      </Field>
      <Field id="cf-type" label="Type">
        <Select id="cf-type" label="Type" value={type} options={typeOptions} onChange={setType} />
      </Field>
      {type === 'choice' && (
        <Field id="cf-options" label="Options" help="Separated by commas.">
          <Input
            id="cf-options"
            value={options}
            placeholder="Apartment, House, Commercial"
            onChange={e => setOptions(e.target.value)}
          />
        </Field>
      )}
      <SwitchRow
        title="Ask every caller"
        description="The assistant asks for it during the call, after it knows what the caller needs."
        on={askCaller}
        onChange={setAskCaller}
      />
      <Field id="cf-instruction" label="Instruction" aside="Optional" help="How or when to ask, in your words.">
        <TextArea
          id="cf-instruction"
          value={instruction}
          placeholder="Only ask when they want a quote."
          onChange={setInstruction}
        />
      </Field>
    </Dialog>
  )
}

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

function ExportCalls({ toast }: Pick<Props, 'toast'>) {
  const today = new Date()
  const [from, setFrom] = useState(() => isoDay(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [to, setTo] = useState(() => isoDay(today))
  const [busy, setBusy] = useState(false)
  async function run() {
    setBusy(true)
    try {
      const data = await callAction<CallExportData>('call.export', { from, to })
      download(data.filename, data.csv)
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
      description="A CSV file with each call's details, tag, custom fields and summary, for a spreadsheet or your CRM."
    >
      <div className="cf-export">
        <Field id="ex-from" label="From">
          <Input id="ex-from" type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} />
        </Field>
        <Field id="ex-to" label="To">
          <Input id="ex-to" type="date" value={to} min={from} onChange={e => setTo(e.target.value)} />
        </Field>
        <Button disabled={busy || !from || !to} onClick={run}>
          {busy ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>
    </Section>
  )
}
