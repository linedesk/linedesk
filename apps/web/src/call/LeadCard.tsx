// The call as a lead: its tag, who to call back where, the job, the urgency and the workspace's custom
// fields. Filled after the call; every field edits in place through the outbox.
import { coerceCustomValue, customValueText, tagLabels } from '@linedesk/actions'
import { type Call, type CallTag, type CustomField, type CustomValue, callTags } from '@linedesk/db/types'
import { useRun } from '../store.tsx'
import { useCustomFields } from '../settings/CallDetails.tsx'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { EditableFact } from './EditableFact.tsx'

const NO_TAG = 'none'
type TagChoice = CallTag | typeof NO_TAG
const tagOptions: SelectOption<TagChoice>[] = [
  { value: NO_TAG, label: 'No tag' },
  ...callTags.map(tag => ({ value: tag, label: tagLabels[tag] })),
]
const urgencyOptions: SelectOption<Call['urgency']>[] = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
]
type Lead = 'callerName' | 'callbackNumber' | 'address' | 'jobType'

/** Tag a call: a select at the top of the card (also offered in ⌘K). */
export function TagSelect({ call }: { call: Call }) {
  const run = useRun()
  return (
    <Select
      size="sm"
      align="end"
      label="Tag"
      value={call.tag ?? NO_TAG}
      options={tagOptions}
      onChange={tag => void run('call.setTag', { callId: call.id, tag: tag === NO_TAG ? null : tag })}
    />
  )
}

const UNSET = ''
function ChoiceFact({
  field,
  value,
  onSave,
}: {
  field: CustomField
  value: CustomValue | undefined
  onSave: (v: CustomValue | null) => void
}) {
  const options: SelectOption<string>[] =
    field.type === 'boolean'
      ? [
          { value: UNSET, label: '—' },
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ]
      : [{ value: UNSET, label: '—' }, ...field.options.map(o => ({ value: o, label: o }))]
  const current = value === undefined ? UNSET : field.type === 'boolean' ? (value ? 'yes' : 'no') : String(value)
  return (
    <>
      <dt>{field.label}</dt>
      <dd>
        <Select
          size="sm"
          label={field.label}
          value={current}
          options={options}
          onChange={v => onSave(v === UNSET ? null : field.type === 'boolean' ? v === 'yes' : v)}
        />
      </dd>
    </>
  )
}

export function LeadCard({ call }: { call: Call }) {
  const run = useRun()
  const fields = useCustomFields()
  if (call.status === 'live') return null
  const saveLead = (field: Lead) => (value: string | null) =>
    void run('call.updateLead', { callId: call.id, [field]: value })
  function saveCustom(field: CustomField, value: CustomValue | null) {
    // A value that does not fit goes as typed: the server refuses it and the change is rolled back with its reason.
    const checked = value === null ? null : coerceCustomValue(field, value)
    const next = checked === null ? null : 'value' in checked ? checked.value : value
    // The whole map, so the optimistic replace matches what the server keeps.
    const values: Record<string, CustomValue | null> = { ...call.custom_values, [field.id]: next }
    void run('call.setCustomValues', { callId: call.id, values })
  }
  return (
    <section className="sumcard lead-card" aria-label="Details">
      <div className="sum-h">
        <b>Details</b>
        <span className="lead-tag">
          <TagSelect call={call} />
        </span>
      </div>
      <dl className="facts lead-facts">
        <EditableFact label="Caller" value={call.caller_name} placeholder="Add name" onSave={saveLead('callerName')} />
        <EditableFact
          label="Call back on"
          value={call.callback_number}
          placeholder="Add number"
          onSave={saveLead('callbackNumber')}
        />
        <EditableFact label="Address" value={call.address} placeholder="Add address" onSave={saveLead('address')} />
        <EditableFact label="Job type" value={call.job_type} placeholder="Add job type" onSave={saveLead('jobType')} />
        <dt>Urgency</dt>
        <dd>
          <Select
            size="sm"
            label="Urgency"
            value={call.urgency}
            options={urgencyOptions}
            onChange={urgency => void run('call.updateLead', { callId: call.id, urgency })}
          />
        </dd>
        {fields.map(field =>
          field.type === 'boolean' || field.type === 'choice' ? (
            <ChoiceFact
              key={field.id}
              field={field}
              value={call.custom_values[field.id]}
              onSave={v => saveCustom(field, v)}
            />
          ) : (
            <EditableFact
              key={field.id}
              label={field.label}
              value={customValueText(call.custom_values[field.id]) || null}
              placeholder={field.type === 'number' ? 'Add number' : 'Add'}
              onSave={v => saveCustom(field, v)}
            />
          ),
        )}
      </dl>
    </section>
  )
}
