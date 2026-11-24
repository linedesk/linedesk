// Add a contact by hand, in the panel beside the list, with every detail a contact has: name and phone first,
// then the rest as on the contact page. Enter saves (Shift+Enter is a new line in the note), Esc closes.
import { type FormEvent, type KeyboardEvent, useRef, useState } from 'react'
import { useAssistants, useRun } from '../store.tsx'
import { useDefaultPhoneCountry } from '../phoneCountry.ts'
import { Card, FormField } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { PhoneInput } from '../ui/PhoneInput.tsx'
import { ContactField } from './ContactDetail.tsx'
import {
  CONTACT_DETAIL_FIELDS,
  EMPTY_NEW_CONTACT,
  NEW_CONTACT_MAX_LENGTH,
  type NewContactForm,
  newContactInput,
  noteHint,
} from './model.ts'
import { useT } from '@linedesk/i18n/react'

type Props = {
  /** Numbers already in Contacts, in E.164: adding one again says so instead of failing on the server. */
  existing: ReadonlySet<string>
  onAdded: (phone: string) => void
  onClose: () => void
}

/** Enter in the note saves the contact like in every other field; Shift+Enter starts a new line. */
function submitOnEnter(e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
  e.preventDefault()
  e.currentTarget.form?.requestSubmit()
}

export function NewContact({ existing, onAdded, onClose }: Props) {
  const t = useT()
  const run = useRun()
  const assistantNames = useAssistants().map(a => a.name)
  const [form, setForm] = useState<NewContactForm>(EMPTY_NEW_CONTACT)
  const [problem, setProblem] = useState<string | null>(null)
  const phoneInput = useRef<HTMLInputElement>(null)
  const defaultCountry = useDefaultPhoneCountry()
  const set = (field: keyof NewContactForm) => (e: { target: { value: string } }) =>
    setForm(f => ({ ...f, [field]: e.target.value }))

  function submit(e: FormEvent) {
    e.preventDefault()
    const result = newContactInput(form, existing)
    if (result.problem !== undefined) {
      setProblem(result.problem)
      return phoneInput.current?.focus() // the field the message is under
    }
    void run('contact.create', result.input)
    onAdded(result.input.phone)
  }

  return (
    <aside className="cv-side cust-side ct-detail" aria-label={t('contacts.new.label')} data-esc-closes>
      <form className="ct-detail-in" onSubmit={submit} noValidate>
        <header className="ct-head">
          <div className="ct-who">
            <b>{t('contacts.new.label')}</b>
          </div>
        </header>
        <Card className="ct-card">
          <div className="ct-grid">
            <ContactField
              id="ct-new-name"
              label={t('contacts.field.name')}
              placeholder={t('contacts.field.namePlaceholder')}
              value={form.name}
              maxLength={NEW_CONTACT_MAX_LENGTH.name}
              autoFocus
              onChange={set('name')}
            />
            <FormField id="ct-new-phone" label={t('contacts.field.phone')} error={problem}>
              <PhoneInput
                id="ct-new-phone"
                value={form.phone}
                defaultCountry={defaultCountry}
                autoComplete="off"
                inputRef={phoneInput}
                invalid={!!problem}
                onChange={phone => {
                  setForm(f => ({ ...f, phone }))
                  setProblem(null)
                }}
              />
            </FormField>
          </div>
        </Card>
        <Card title={t('contacts.detail.details')} className="ct-card">
          <div className="ct-grid">
            {CONTACT_DETAIL_FIELDS.map(({ field, ...f }) => (
              <ContactField
                key={field}
                id={`ct-new-${field}`}
                label={t(f.label)}
                placeholder={t(f.placeholder)}
                multiline={'multiline' in f}
                value={form[field]}
                maxLength={NEW_CONTACT_MAX_LENGTH[field]}
                hint={field === 'note' ? noteHint(assistantNames) : undefined}
                onChange={set(field)}
                onKeyDown={'multiline' in f ? submitOnEnter : undefined}
              />
            ))}
          </div>
        </Card>
        <div className="ct-new-acts">
          <Button
            variant="ghost"
            shortcut={['esc']}
            title={t('common.action.closeWithKey', { key: 'esc' })}
            onClick={onClose}
          >
            {t('common.action.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            shortcut={['⏎']}
            title={t('common.withKey', { label: t('contacts.new.add'), key: '⏎' })}
          >
            {t('contacts.new.add')}
          </Button>
        </div>
      </form>
    </aside>
  )
}
