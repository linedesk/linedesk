// Settings › Assistant › Booking & calendar: the dialog for one of the workspace's own appointment types (length,
// "use this type when", buffers, when it can be booked, what the assistant asks first), and its delete.
import type { AppointmentType } from '@linedesk/db/types'
import { CONDITION_MAX } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useState } from 'react'
import { useRun } from '../store.tsx'
import { Checkbox, Select, type SelectOption } from '../ui/controls.tsx'
import { Dialog, Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { DeleteButton } from '../ui/list.tsx'
import { EditBusinessHours } from './BusinessHoursDialog.tsx'
import {
  BOOK_WHEN,
  BOOKING_FIELDS,
  type BookingFieldId,
  type BookWhen,
  BUFFERS,
  bookWhenLabel,
  bufferLabel,
  DURATIONS,
  durationLabel,
  fieldLabel,
  typeFields,
} from './calendarModel.ts'
import { Field } from './fields.tsx'

/** A new type (no `type`) or a change to one. Saving applies at once (appointmentType.upsert), like the rest of the page. */
export function AppointmentTypeDialog({
  type,
  assistantName,
  onClose,
}: {
  type?: AppointmentType
  assistantName: string
  onClose: () => void
}) {
  const t = useT()
  const run = useRun()
  const durationOptions = DURATIONS.map(d => ({ value: String(d), label: durationLabel(d) })) as SelectOption<string>[]
  const bufferOptions = BUFFERS.map(b => ({ value: String(b), label: bufferLabel(b) })) as SelectOption<string>[]
  const bookWhenOptions = BOOK_WHEN.map(value => ({ value, label: bookWhenLabel(value) })) as SelectOption<BookWhen>[]
  const [name, setName] = useState(type?.name ?? '')
  const [duration, setDuration] = useState(String(type?.duration_min ?? 60))
  const [fields, setFields] = useState<BookingFieldId[]>(type ? typeFields(type) : ['name', 'address'])
  const [condition, setCondition] = useState(type?.instruction ?? '')
  const [before, setBefore] = useState(String(type?.buffer_before_min ?? 0))
  const [after, setAfter] = useState(String(type?.buffer_after_min ?? 0))
  const [when, setWhen] = useState<BookWhen>(type?.book_when ?? 'business_hours')
  function save(e?: FormEvent) {
    e?.preventDefault()
    if (!name.trim()) return
    void run('appointmentType.upsert', {
      ...(type ? { appointmentTypeId: type.id } : {}),
      name: name.trim(),
      durationMin: Number(duration),
      requiredFields: fields,
      instruction: condition.trim(),
      bufferBeforeMin: Number(before),
      bufferAfterMin: Number(after),
      bookWhen: when,
    })
    onClose()
  }
  return (
    <Dialog
      title={type ? type.name : t('settings.calendar.type.newTitle')}
      description={t('settings.calendar.type.description', { name: assistantName })}
      size="md"
      onClose={onClose}
      onSubmit={save}
      footer={
        <>
          <Button onClick={onClose}>{t('common.action.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!name.trim()}
            title={t('common.action.saveWithKey', { key: '⌘S' })}
          >
            {type ? t('common.action.save') : t('settings.calendar.add')}
          </Button>
        </>
      }
    >
      <div className="cal-type-form">
        <div className="k-fields-2">
          <Field id="cal-type-name" label={t('settings.calendar.type.name')}>
            <Input
              id="cal-type-name"
              value={name}
              placeholder={t('settings.calendar.type.nameExample')}
              onChange={e => setName(e.target.value)}
            />
          </Field>
          <Field id="cal-type-duration" label={t('settings.calendar.type.length')}>
            <Select
              id="cal-type-duration"
              label={t('settings.calendar.type.length')}
              value={duration}
              options={durationOptions}
              onChange={setDuration}
            />
          </Field>
        </div>
        <Field
          id="cal-type-when"
          label={t('settings.calendar.condition.type')}
          tip={t('settings.calendar.type.conditionTip')}
        >
          <Input
            id="cal-type-when"
            value={condition}
            placeholder={t('settings.calendar.condition.typeExample')}
            maxLength={CONDITION_MAX}
            onChange={e => setCondition(e.target.value)}
          />
        </Field>
        <div className="cal-type-rules">
          <Field
            id="cal-type-before"
            label={t('settings.calendar.type.bufferBefore')}
            tip={t('settings.calendar.type.bufferBeforeTip')}
          >
            <Select
              id="cal-type-before"
              label={t('settings.calendar.type.bufferBefore')}
              value={before}
              options={bufferOptions}
              onChange={setBefore}
            />
          </Field>
          <Field
            id="cal-type-after"
            label={t('settings.calendar.type.bufferAfter')}
            tip={t('settings.calendar.type.bufferAfterTip')}
          >
            <Select
              id="cal-type-after"
              label={t('settings.calendar.type.bufferAfter')}
              value={after}
              options={bufferOptions}
              onChange={setAfter}
            />
          </Field>
          <Field id="cal-type-hours" label={t('settings.calendar.type.canBeBooked')}>
            <span className="bh-with">
              <Select
                id="cal-type-hours"
                label={t('settings.calendar.type.canBeBooked')}
                value={when}
                options={bookWhenOptions}
                onChange={setWhen}
              />
              {when !== 'any_time' && <EditBusinessHours canEdit />}
            </span>
          </Field>
        </div>
        <Field label={t('settings.calendar.type.askFor')} tip={t('settings.calendar.type.askForTip')}>
          <span className="cal-type-fields">
            {BOOKING_FIELDS.map(f => (
              <Checkbox
                key={f}
                checked={fields.includes(f)}
                onChange={on => setFields(all => (on ? [...all, f] : all.filter(x => x !== f)))}
              >
                {fieldLabel(f)}
              </Checkbox>
            ))}
          </span>
        </Field>
        {type && (
          <div className="cal-type-delete">
            <span>{t('settings.calendar.type.deleteNote')}</span>
            <DeleteButton
              name={type.name}
              onDelete={() => {
                void run('appointmentType.delete', { appointmentTypeId: type.id })
                onClose()
              }}
            />
          </div>
        )}
      </div>
    </Dialog>
  )
}
