// Merge two contacts that are one person (contact.merge): pick the other contact if it is not given,
// choose which one to keep and, where both have a different value, which value. The other one's
// calls move to the kept contact; a later call from its number lands there too.
import type { Contact } from '@linedesk/db/types'
import { type FormEvent, useState } from 'react'
import { formatPhone } from '../inbox-model.ts'
import { useRun } from '../store.tsx'
import { RadioCard, Select } from '../ui/controls.tsx'
import { Dialog, FormField } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { contactLabel, type ContactRow, duplicatePairs, MERGE_FIELDS, type MergeField, mergeDefaults } from './model.ts'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { i18n } from '../i18n/index.tsx'

const FIELD_LABEL = {
  name: msg('contacts.field.name'),
  company: msg('contacts.field.company'),
  email: msg('contacts.field.email'),
  address: msg('contacts.field.address'),
  note: msg('contacts.field.note'),
} satisfies Record<MergeField, MessageKey>

const who = (contact: Contact) =>
  contact.name
    ? i18n().t('contacts.merge.who', { name: contact.name, number: formatPhone(contact.phone) })
    : formatPhone(contact.phone)

type Props = {
  /** The contact the merge starts from; it is kept unless the member swaps. */
  first: ContactRow
  /** The other contact, when known (a suggested duplicate); else the member picks it. */
  second: ContactRow | null
  /** Every contact that can be picked. */
  all: ContactRow[]
  onClose: () => void
  toast: (text: string) => void
}

export function MergeContacts({ first, second, all, onClose, toast }: Props) {
  const t = useT()
  const run = useRun()
  const candidates = all.filter(r => r.contact.id !== first.contact.id)
  // Picking: a contact with the same number or email comes first, if there is one.
  const likely = () =>
    duplicatePairs([first.contact, ...candidates.map(r => r.contact)])
      .find(pair => pair.includes(first.contact))
      ?.find(c => c !== first.contact)
  const [otherId, setOtherId] = useState(() => second?.contact.id ?? likely()?.id ?? candidates[0]?.contact.id ?? '')
  const [swapped, setSwapped] = useState(false)
  const other = all.find(r => r.contact.id === otherId)
  const [keep, merge] = other && swapped ? [other, first] : [first, other]
  const defaults = merge ? mergeDefaults(keep.contact, merge.contact) : null
  const [picked, setPicked] = useState<Partial<Record<MergeField, 'keep' | 'merge'>>>({})

  if (!merge || !defaults)
    return (
      <Dialog title={t('contacts.merge.title')} description={t('contacts.merge.noOther')} onClose={onClose}>
        {null}
      </Dialog>
    )

  const value = (field: MergeField) => (picked[field] === 'merge' ? merge.contact[field] : defaults.values[field])

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!merge) return
    const values = Object.fromEntries(MERGE_FIELDS.map(f => [f, value(f)]))
    void run('contact.merge', { keepId: keep.contact.id, mergeId: merge.contact.id, ...values })
    toast(
      merge.calls.length
        ? t('contacts.merge.doneMoved', { name: contactLabel(keep.contact), count: merge.calls.length })
        : t('contacts.merge.done', { name: contactLabel(keep.contact) }),
    )
    onClose()
  }

  return (
    <Dialog
      title={t('contacts.merge.title')}
      description={t('contacts.merge.description', {
        merge: contactLabel(merge.contact),
        keep: contactLabel(keep.contact),
        count: merge.calls.length,
        number: formatPhone(merge.contact.phone),
      })}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t('common.action.cancel')}</Button>
          <Button type="submit" variant="primary">
            {t('contacts.merge.merge')}
          </Button>
        </>
      }
    >
      {!second && (
        <FormField id="merge-other" label={t('contacts.merge.with')}>
          <div>
            <Select
              id="merge-other"
              label={t('contacts.merge.with')}
              value={otherId}
              options={candidates.map(r => ({ value: r.contact.id, label: who(r.contact) }))}
              onChange={id => {
                setOtherId(id)
                setPicked({})
              }}
            />
          </div>
        </FormField>
      )}
      <FormField label={t('contacts.merge.keep')}>
        <div className="merge-pick" role="radiogroup" aria-label={t('contacts.merge.keep')}>
          {[first, other!].map(row => (
            <RadioCard
              key={row.contact.id}
              name="merge-keep"
              checked={keep.contact.id === row.contact.id}
              onPick={() => {
                setSwapped(row !== first)
                setPicked({})
              }}
              title={contactLabel(row.contact)}
              description={t('contacts.merge.rowDescription', {
                number: formatPhone(row.contact.phone),
                count: row.calls.length,
              })}
            />
          ))}
        </div>
      </FormField>
      {defaults.choices.map(field => (
        <FormField key={field} label={t(FIELD_LABEL[field])}>
          <div className="merge-pick" role="radiogroup" aria-label={t(FIELD_LABEL[field])}>
            {(['keep', 'merge'] as const).map(side => (
              <RadioCard
                key={side}
                name={`merge-${field}`}
                checked={(picked[field] ?? 'keep') === side}
                onPick={() => setPicked(p => ({ ...p, [field]: side }))}
                title={(side === 'keep' ? keep : merge).contact[field]}
              />
            ))}
          </div>
        </FormField>
      ))}
    </Dialog>
  )
}
