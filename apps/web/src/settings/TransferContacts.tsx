// Settings > Assistant > Transfers: the people the assistant puts callers through to (warm transfer),
// each with a plain-language condition, in order. One compact row per contact; a row opens in place to
// edit it (Done or Esc closes it). Part of the assistant's draft: saved with the page's Save. A field's error
// shows once the field was left or a save was tried, never on a row just added. A row just added stays out of the
// draft until one of its fields is changed: Esc, Done, Remove or leaving the section drops it (no unsaved change).
import { countryList, RING_SECONDS_MAX, RING_SECONDS_MIN } from '@linedesk/actions'
import type { TransferFallback } from '@linedesk/db/types'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useRef, useState } from 'react'
import { Checkbox, Select, type SelectOption, Switch } from '../ui/controls.tsx'
import { Input, Textarea } from '../ui/form.tsx'
import { HelpTip } from '../ui/HelpTip.tsx'
import { NO_PASSWORD_MANAGER } from '../ui/passwordManager.ts'
import { Button, cx } from '../ui/kit.tsx'
import { PhoneInput } from '../ui/PhoneInput.tsx'
import { formatNumber, outboundE164 } from '../onboarding/flow.ts'
import { useOutboundCountries } from '../onboarding/outbound-number.ts'
import { useDefaultPhoneCountry } from '../phoneCountry.ts'
import {
  canAddPendingTransfer,
  editTransfer,
  isPendingRow,
  moveTransfer,
  newTransferContact,
  refusedForCountry,
  removeTransfer,
  type TransferDraft,
  type TransferEdit,
  type TransferProblem,
  transferInactive,
  transferProblem,
  transferRows,
} from './assistantDraft.ts'
import { EditBusinessHours } from './BusinessHoursDialog.tsx'
import { Field, Section } from './fields.tsx'
import { brandName } from '../brand.ts'
import { i18n } from '../i18n/index.tsx'
import { fmt, intlLocale } from '../i18n/format.ts'
import { shortDuration } from '../time.ts'

const FALLBACKS: { value: TransferFallback; label: MessageKey }[] = [
  { value: 'message', label: msg('settings.transfer.fallback.message') },
  { value: 'next', label: msg('settings.transfer.fallback.next') },
]
const RING_SECONDS = [10, 15, 20, 25, 30, 45, 60].filter(s => s >= RING_SECONDS_MIN && s <= RING_SECONDS_MAX)

/** The number in the contact's row: E.164, a North American one spaced out ("+1 503 555 0100"). */
const numberLabel = (typed: string) => {
  const e164 = outboundE164(typed)
  return e164 ? formatNumber(e164) : typed.trim() || i18n().t('settings.transfer.noNumber')
}

/** "the United States", "Canada and Mexico" in English (countryList); the region names in the active language otherwise. */
function countryNames(countries: readonly string[]): string {
  const locale = intlLocale()
  if (locale === 'en') return countryList(countries)
  const names = new Intl.DisplayNames(locale, { type: 'region' })
  return fmt().list(countries.map(c => names.of(c) ?? c))
}

/** The number field's tip: where calls may be put through (the workspace's countries), never a Linedesk number. */
const numberTip = (countries: readonly string[] | 'any') =>
  countries !== 'any' && countries.length
    ? i18n().t('settings.transfer.numberTipIn', { countries: countryNames(countries), brand: brandName() })
    : i18n().t('settings.transfer.numberTip', { brand: brandName() })

/** The id of a contact's field, for the label and for putting the cursor there after a failed save. */
export const transferFieldId = (index: number, field: TransferProblem['field'] | 'row') => `tc-${index}-${field}`
const ADD_ID = 'tc-add'

type Props = {
  transfers: TransferDraft[]
  onChange: (transfers: TransferDraft[]) => void
  /** The workspace uses business hours: "only during business hours" can apply. */
  hoursOn: boolean
  assistantName: string
  /** A save was refused: every problem shows, and the row with the first one opens. */
  showErrors?: boolean
}

/** Condition examples under an empty condition. */
const EXAMPLES: { label: MessageKey; condition: MessageKey }[] = [
  { label: msg('settings.transfer.example.person'), condition: msg('settings.transfer.example.personCondition') },
  { label: msg('settings.transfer.example.billing'), condition: msg('settings.transfer.example.billingCondition') },
]

export function TransferContacts({ transfers, onChange, hoursOn, assistantName, showErrors = false }: Props) {
  const t = useT()
  const [open, setOpen] = useState<string | null>(null)
  /** Fields left at least once, as `<contact id>:<field>`: their errors show. */
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const countries = useOutboundCountries()
  const country = useDefaultPhoneCountry()
  /** The contact just added while none of its fields was changed: shown, but not in the draft (no change yet). */
  const [pending, setPending] = useState<TransferDraft | null>(null)
  /** Contacts added during this visit: their open row keeps a Remove next to Done. */
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set())
  const edit: TransferEdit = { transfers, pending }
  const rows = transferRows(edit)
  const problem = transferProblem({ transfers }, countries)
  function apply(next: TransferEdit) {
    if (next.transfers !== transfers) onChange(next.transfers)
    if (next.pending !== pending) setPending(next.pending)
  }
  const focusName = (index: number) =>
    setTimeout(() => document.getElementById(transferFieldId(index, 'name'))?.focus(), 0)
  function add() {
    if (pending) {
      setOpen(pending.id)
      return focusName(transfers.length)
    }
    const contact = newTransferContact(transfers, 'blank')
    setPending(contact)
    setAdded(ids => new Set(ids).add(contact.id))
    setOpen(contact.id)
    focusName(transfers.length)
  }
  /** Done or Esc: the row closes; the untouched new contact goes away (nothing was entered). */
  function close(index: number) {
    setOpen(null)
    const dropped = isPendingRow(edit, index)
    if (dropped) setPending(null)
    // The focus stays in the list: on the row that closed, or on Add contact when the row went away.
    setTimeout(() => document.getElementById(dropped ? ADD_ID : transferFieldId(index, 'row'))?.focus(), 0)
  }
  return (
    <Section
      id="as-transfer"
      title={t('settings.transfer.title')}
      description={t('settings.transfer.description')}
      actions={
        <Button id={ADD_ID} size="sm" icon="plus" disabled={!canAddPendingTransfer(edit)} onClick={add}>
          {t('settings.transfer.add')}
        </Button>
      }
      help={t('settings.transfer.help', { name: assistantName })}
    >
      {rows.length ? (
        <ol className="tc-list">
          {rows.map((c, i) => {
            const isNew = isPendingRow(edit, i)
            const mine = problem?.index === i ? problem : null
            // A number refused for its country shows at once: also one saved before the server's countries changed.
            const shown =
              mine &&
              (showErrors ||
                touched.has(`${c.id}:${mine.field}`) ||
                (mine.field === 'number' && refusedForCountry(c.number, countries)))
                ? mine
                : null
            return (
              <ContactRow
                key={c.id}
                contact={c}
                index={i}
                count={transfers.length}
                isNew={isNew}
                added={added.has(c.id)}
                open={open === c.id || (showErrors && !!mine)}
                problem={shown}
                hoursOn={hoursOn}
                numberTip={numberTip(countries)}
                defaultCountry={country}
                onToggle={() => setOpen(open === c.id ? null : c.id)}
                onClose={() => close(i)}
                onLeave={field => setTouched(seen => new Set(seen).add(`${c.id}:${field}`))}
                onChange={patch => apply(editTransfer(edit, i, patch))}
                onMove={by => onChange(moveTransfer(transfers, i, by))}
                onRemove={() => apply(removeTransfer(edit, i))}
              />
            )
          })}
        </ol>
      ) : (
        <p className="tc-empty">{t('settings.transfer.empty', { name: assistantName })}</p>
      )}
    </Section>
  )
}

export type RowProps = {
  contact: TransferDraft
  index: number
  count: number
  /** The contact was just added and none of its fields changed yet: not moved, no status yet. */
  isNew?: boolean
  /** Added during this visit: a Remove next to Done (the others are removed with the row's trash button). */
  added?: boolean
  open: boolean
  /** The problem to show in this row (null: none, or not shown yet). */
  problem: TransferProblem | null
  hoursOn: boolean
  /** What the number field's tip says about where calls may go. */
  numberTip: string
  /** The country the phone field starts on: the workspace's (its first Linedesk number). */
  defaultCountry: string
  onToggle: () => void
  /** Done or Esc in the open row. */
  onClose: () => void
  onLeave: (field: TransferProblem['field']) => void
  onChange: (patch: Partial<TransferDraft>) => void
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}

/** The muted line under a contact's name: ring time, fallback, hours, and "put straight through" without a briefing. */
function summaryOf(c: TransferDraft, hoursOn: boolean): string {
  const summary = i18n().t('settings.transfer.summary', {
    duration: shortDuration(c.ring_seconds),
    fallback: c.if_no_answer,
    hoursOnly: hoursOn && c.hours_only ? 'yes' : 'no',
  })
  return c.briefing ? summary : i18n().t('settings.transfer.summaryDirect', { summary })
}

/** Grows the condition box with its text, from two lines up to the CSS max-height. */
function grow(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight + 2}px`
}

export function ContactRow(props: RowProps) {
  const {
    contact: c,
    index,
    count,
    isNew = false,
    added = isNew,
    open,
    problem,
    hoursOn,
    numberTip,
    defaultCountry,
    onToggle,
    onClose,
    onLeave,
    onChange,
    onMove,
    onRemove,
  } = props
  const t = useT()
  const inactive = isNew ? null : transferInactive(c)
  const name = c.name.trim() || t('settings.transfer.newContact')
  const ringOptions: SelectOption<string>[] = RING_SECONDS.map(s => ({
    value: String(s),
    label: t('settings.transfer.ringSeconds', { count: s }),
  }))
  const fallbackOptions: SelectOption<TransferFallback>[] = FALLBACKS.map(o => ({ value: o.value, label: t(o.label) }))
  const id = (field: TransferProblem['field']) => transferFieldId(index, field)
  const error = (field: TransferProblem['field']) => (problem?.field === field ? problem.message : null)
  const condition = useRef<HTMLTextAreaElement>(null)
  return (
    <li
      className={cx('tc-row', inactive && 'is-off', open && 'is-open')}
      onKeyDown={e => {
        // Esc closes the open row (a list or menu inside it closes first and marks the key as handled).
        if (e.key !== 'Escape' || !open || e.defaultPrevented) return
        e.preventDefault()
        e.stopPropagation()
        onClose()
      }}
    >
      <div className="tc-line">
        <span className="tc-order" aria-hidden>
          {index + 1}
        </span>
        <button
          type="button"
          id={transferFieldId(index, 'row')}
          className="tc-main"
          onClick={onToggle}
          aria-expanded={open}
          title={open ? t('common.action.close') : t('settings.transfer.edit')}
        >
          <span className="tc-title">
            <b>{name}</b>
            <span className="tc-number">{numberLabel(c.number)}</span>
            {inactive && <span className="tc-status">{inactive}</span>}
          </span>
          <span className="tc-cond">{c.condition.trim() || t('settings.transfer.noCondition')}</span>
          <span className="tc-meta">{summaryOf(c, hoursOn)}</span>
        </button>
        <span className="tc-actions">
          <Button
            size="sm"
            variant="ghost"
            icon="up"
            title={t('settings.transfer.moveUp')}
            aria-label={t('settings.transfer.moveUpName', { name })}
            disabled={isNew || index === 0}
            onClick={() => onMove(-1)}
          />
          <Button
            size="sm"
            variant="ghost"
            icon="down"
            title={t('settings.transfer.moveDown')}
            aria-label={t('settings.transfer.moveDownName', { name })}
            disabled={isNew || index === count - 1}
            onClick={() => onMove(1)}
          />
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            title={t('settings.transfer.remove')}
            aria-label={t('settings.transfer.removeName', { name })}
            onClick={onRemove}
          />
          <Switch
            on={c.enabled}
            onChange={on => onChange({ enabled: on })}
            label={t('settings.transfer.toggle', { name })}
          />
        </span>
      </div>
      {open && (
        <div className="tc-edit">
          <div className="tc-grid tc-grid-who">
            <Field id={id('name')} label={t('settings.transfer.name')} error={error('name')}>
              <Input
                id={id('name')}
                {...NO_PASSWORD_MANAGER}
                value={c.name}
                onChange={e => onChange({ name: e.target.value })}
                onBlur={() => onLeave('name')}
                placeholder={t('settings.transfer.namePlaceholder')}
                invalid={!!error('name')}
              />
            </Field>
            <Field id={id('number')} label={t('settings.transfer.number')} error={error('number')} tip={numberTip}>
              <PhoneInput
                id={id('number')}
                value={c.number}
                defaultCountry={defaultCountry}
                autoComplete="off"
                onChange={number => onChange({ number })}
                onBlur={() => onLeave('number')}
                invalid={!!error('number')}
              />
            </Field>
          </div>
          <div className="tc-briefing">
            <span className="bh-with">
              <Checkbox checked={c.briefing} onChange={on => onChange({ briefing: on })}>
                {t('settings.transfer.briefing')}
              </Checkbox>
              <HelpTip label={t('settings.transfer.briefingTipLabel')} text={t('settings.transfer.briefingTip')} />
            </span>
            {/* TCPA: with the briefing a transfer is an outbound call that opens with an AI voice, so the person must have
                agreed (terms, A10). Without it nothing artificial is said to them: no hint, only what changes. */}
            <p className="tc-consent">
              {t(c.briefing ? 'settings.transfer.consent' : 'settings.transfer.briefingOff')}
            </p>
          </div>
          <Field id={id('condition')} label={t('settings.transfer.condition')} error={error('condition')}>
            <Textarea
              id={id('condition')}
              ref={el => {
                condition.current = el
                grow(el)
              }}
              className="tc-cond-input"
              rows={2}
              value={c.condition}
              onChange={e => {
                onChange({ condition: e.target.value })
                grow(e.target)
              }}
              onBlur={() => onLeave('condition')}
              placeholder={t('settings.transfer.conditionPlaceholder')}
              invalid={!!error('condition')}
            />
            {!c.condition.trim() && (
              <span className="tc-examples">
                {t('settings.transfer.examples')}
                {EXAMPLES.map(example => (
                  <button
                    key={example.label}
                    type="button"
                    className="tc-example"
                    onClick={() => {
                      onChange({ condition: t(example.condition) })
                      setTimeout(() => condition.current?.focus(), 0)
                    }}
                  >
                    {t(example.label)}
                  </button>
                ))}
              </span>
            )}
          </Field>
          <div className="tc-grid tc-grid-then">
            <Field id={`tc-${index}-ring`} label={t('settings.transfer.ringFor')}>
              <Select
                id={`tc-${index}-ring`}
                label={t('settings.transfer.ringFor')}
                value={String(c.ring_seconds)}
                options={ringOptions}
                onChange={v => onChange({ ring_seconds: Number(v) })}
              />
            </Field>
            <Field id={`tc-${index}-fallback`} label={t('settings.transfer.ifNobody')}>
              <Select
                id={`tc-${index}-fallback`}
                label={t('settings.transfer.ifNobody')}
                value={c.if_no_answer}
                options={fallbackOptions}
                onChange={v => onChange({ if_no_answer: v })}
              />
            </Field>
          </div>
          <div className="tc-foot">
            {/* The icon is inside the page's fieldset: disabled with it for members who cannot edit. */}
            {hoursOn ? (
              <span className="bh-with">
                <Checkbox checked={c.hours_only} onChange={on => onChange({ hours_only: on })}>
                  {t('settings.transfer.hoursOnly')}
                </Checkbox>
                <EditBusinessHours canEdit />
              </span>
            ) : (
              <span className="bh-with tc-anytime">
                {t('settings.transfer.anyTime')}
                <EditBusinessHours canEdit label={t('settings.transfer.setHours')} />
              </span>
            )}
            {/* Remove and Done stay together at the end, also when the row wraps on a phone. */}
            <span className="tc-foot-actions">
              {added && (
                <Button size="sm" variant="ghost" onClick={onRemove}>
                  {t('settings.transfer.remove')}
                </Button>
              )}
              <Button size="sm" onClick={onClose} title={t('settings.transfer.doneTip')}>
                {t('settings.transfer.done')}
              </Button>
            </span>
          </div>
        </div>
      )}
    </li>
  )
}
