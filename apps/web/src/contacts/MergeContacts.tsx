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

const FIELD_LABEL: Record<MergeField, string> = {
  name: 'Name',
  company: 'Company',
  email: 'Email',
  address: 'Address',
  note: 'Note',
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const who = (contact: Contact) =>
  contact.name ? `${contact.name} · ${formatPhone(contact.phone)}` : formatPhone(contact.phone)

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
      <Dialog title="Merge contacts" description="There is no other contact to merge with." onClose={onClose}>
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
      `Merged into ${contactLabel(keep.contact)}.${merge.calls.length ? ` ${plural(merge.calls.length, 'call')} moved.` : ''}`,
    )
    onClose()
  }

  return (
    <Dialog
      title="Merge contacts"
      description={`${contactLabel(merge.contact)} goes into ${contactLabel(keep.contact)}: ${merge.calls.length === 1 ? '1 call moves' : `${plural(merge.calls.length, 'call')} move`} over, and calls from ${formatPhone(merge.contact.phone)} land there from now on.`}
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary">
            Merge
          </Button>
        </>
      }
    >
      {!second && (
        <FormField id="merge-other" label="Merge with">
          <div>
            <Select
              id="merge-other"
              label="Merge with"
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
      <FormField label="Keep">
        <div className="merge-pick" role="radiogroup" aria-label="Keep">
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
              description={`${formatPhone(row.contact.phone)} · ${plural(row.calls.length, 'call')}`}
            />
          ))}
        </div>
      </FormField>
      {defaults.choices.map(field => (
        <FormField key={field} label={FIELD_LABEL[field]}>
          <div className="merge-pick" role="radiogroup" aria-label={FIELD_LABEL[field]}>
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
