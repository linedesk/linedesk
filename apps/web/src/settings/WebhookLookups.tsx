// Assistant settings, Advanced, Webhook, During the call: what the assistant can ask the business's system on a call
// (the webhook's lookups, docs/webhooks.md). Each lookup has a name, when to ask and the fields the assistant
// fills in from what the caller says. Saved through the outbox (webhook.update), so the list changes at once;
// Test asks the webhook with made-up values and needs the server's answer.
import {
  LOOKUP_DESCRIPTION_MAX,
  LOOKUP_FIELDS_MAX,
  LOOKUP_WHEN_MAX,
  LOOKUPS_MAX,
  lookupSchema,
  type WebhookTestData,
} from '@linedesk/actions'
import type { LookupField, LookupFieldType, WebhookEndpoint, WebhookLookup } from '@linedesk/db/types'
import { msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useState } from 'react'
import { i18n } from '../i18n/index.tsx'
import { useRun } from '../store.tsx'
import { Checkbox, Select } from '../ui/controls.tsx'
import { Dialog, Input, Textarea } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { DeleteButton, EditButton, List, ListEmpty, ListRow } from '../ui/list.tsx'
import { Field } from './fields.tsx'
import { callAction } from './settings-api.ts'

const TYPES = [
  { value: 'text', label: msg('settings.lookups.type.text') },
  { value: 'number', label: msg('settings.lookups.type.number') },
  { value: 'boolean', label: msg('settings.lookups.type.boolean') },
] as const satisfies readonly { value: LookupFieldType; label: string }[]

/** Examples of names the webhook sees: code, not text, so they stay as they are in every language. */
const NAME_EXAMPLE = 'order_status'
const FIELD_EXAMPLE = 'order_number'

const emptyField = (): LookupField => ({ name: '', type: 'text', description: '', required: true })
const emptyLookup = (): WebhookLookup => ({ name: '', when: '', fields: [emptyField()] })

type Props = { endpoint: WebhookEndpoint; toast: (text: string) => void }

/** The toast after a test lookup: what the webhook answered, or why there is nothing. */
export function lookupTestText(result: WebhookTestData): string {
  const { t } = i18n()
  if (!result.ok) return t('settings.lookups.test.failed', { error: result.error })
  return result.answer
    ? t('settings.lookups.test.answered', { status: result.responseStatus, answer: result.answer })
    : t('settings.lookups.test.noAnswer', { status: result.responseStatus, field: '"answer"' })
}

export function WebhookLookups({ endpoint, toast }: Props) {
  const t = useT()
  const run = useRun()
  const [editing, setEditing] = useState<{ index: number | null } | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const lookups = endpoint.lookups
  const save = (next: WebhookLookup[]) => void run('webhook.update', { endpointId: endpoint.id, lookups: next })

  async function test(lookup: WebhookLookup) {
    setTesting(lookup.name)
    try {
      toast(
        lookupTestText(
          await callAction<WebhookTestData>('webhook.test', {
            endpointId: endpoint.id,
            hook: 'during_call',
            lookup: lookup.name,
          }),
        ),
      )
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="wh-lookups">
      <div className="wh-lookups-head">
        <b className="wh-lookups-title">{t('settings.lookups.label')}</b>
        <Button
          size="sm"
          icon="plus"
          disabled={lookups.length >= LOOKUPS_MAX}
          onClick={() => setEditing({ index: null })}
          title={t('settings.lookups.atMost', { count: LOOKUPS_MAX })}
        >
          {t('settings.lookups.add')}
        </Button>
      </div>
      {lookups.length ? (
        <List label={t('settings.lookups.label')}>
          {lookups.map((lookup, index) => (
            <ListRow
              key={lookup.name}
              title={<code className="wh-key">{lookup.name}</code>}
              sub={lookup.when}
              actions={
                <>
                  <Button
                    busy={testing === lookup.name}
                    size="sm"
                    variant="ghost"
                    disabled={testing !== null}
                    onClick={() => void test(lookup)}
                    title={t('settings.lookups.test.tip')}
                  >
                    {testing === lookup.name ? t('settings.lookups.test.testing') : t('settings.lookups.test.button')}
                  </Button>
                  <EditButton name={lookup.name} onClick={() => setEditing({ index })} />
                  <DeleteButton name={lookup.name} onDelete={() => save(lookups.filter((_, i) => i !== index))} />
                </>
              }
            />
          ))}
        </List>
      ) : (
        <ListEmpty>{t('settings.lookups.empty')}</ListEmpty>
      )}
      {editing && (
        <LookupDialog
          lookup={editing.index === null ? emptyLookup() : lookups[editing.index]!}
          taken={lookups.filter((_, i) => i !== editing.index).map(l => l.name)}
          onClose={() => setEditing(null)}
          onSave={lookup => {
            save(
              editing.index === null ? [...lookups, lookup] : lookups.map((l, i) => (i === editing.index ? lookup : l)),
            )
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}

/** Add or change one lookup: its name, when the assistant asks, and the fields it fills in. */
function LookupDialog({
  lookup,
  taken,
  onClose,
  onSave,
}: {
  lookup: WebhookLookup
  taken: string[]
  onClose: () => void
  onSave: (lookup: WebhookLookup) => void
}) {
  const t = useT()
  const [draft, setDraft] = useState(lookup)
  const [error, setError] = useState<string | null>(null)
  const types = TYPES.map(o => ({ value: o.value, label: t(o.label) }))
  const setField = (index: number, change: Partial<LookupField>) =>
    setDraft(d => ({ ...d, fields: d.fields.map((f, i) => (i === index ? { ...f, ...change } : f)) }))

  function submit(e: FormEvent) {
    e.preventDefault()
    const name = draft.name.trim()
    if (taken.includes(name)) return setError(t('settings.lookups.taken', { name }))
    const parsed = lookupSchema.safeParse({
      ...draft,
      name,
      fields: draft.fields.map(f => ({ ...f, name: f.name.trim() })),
    })
    if (!parsed.success)
      return setError(parsed.error.issues.map(i => `${i.path.join(' ')} ${i.message}`.trim()).join('; '))
    onSave(parsed.data)
  }

  return (
    <Dialog
      title={lookup.name ? t('settings.lookups.dialog.title', { name: lookup.name }) : t('settings.lookups.add')}
      description={t('settings.lookups.dialog.description', {
        hook: '"hook": "during_call"',
        lookup: '"lookup":',
        answer: '{"answer": "…"}',
      })}
      size="lg"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>{t('common.action.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!draft.name.trim() || !draft.when.trim()}>
            {t('common.action.save')}
          </Button>
        </>
      }
    >
      <Field
        id="lk-name"
        label={t('settings.lookups.dialog.name')}
        help={t('settings.lookups.dialog.nameHelp', { example: NAME_EXAMPLE })}
      >
        <Input
          id="lk-name"
          required
          placeholder={NAME_EXAMPLE}
          value={draft.name}
          onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
        />
      </Field>
      <Field id="lk-when" label={t('settings.lookups.dialog.when')}>
        <Textarea
          id="lk-when"
          rows={2}
          maxLength={LOOKUP_WHEN_MAX}
          placeholder={t('settings.lookups.dialog.whenPlaceholder')}
          value={draft.when}
          onChange={e => setDraft(d => ({ ...d, when: e.target.value }))}
        />
      </Field>
      <Field label={t('settings.lookups.dialog.fields')} tip={t('settings.lookups.dialog.fieldsTip')}>
        <div className="wh-fields">
          {draft.fields.map((field, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fields have no id; their name is what is being edited
            <div className="wh-field" key={index}>
              <Input
                aria-label={t('settings.lookups.field.name')}
                placeholder={FIELD_EXAMPLE}
                value={field.name}
                onChange={e => setField(index, { name: e.target.value })}
              />
              <Select
                label={t('settings.lookups.field.type')}
                value={field.type}
                options={types}
                onChange={type => setField(index, { type })}
              />
              <Input
                aria-label={t('settings.lookups.field.description')}
                placeholder={t('settings.lookups.field.descriptionPlaceholder')}
                maxLength={LOOKUP_DESCRIPTION_MAX}
                value={field.description}
                onChange={e => setField(index, { description: e.target.value })}
              />
              <Checkbox checked={field.required} onChange={required => setField(index, { required })}>
                {t('settings.lookups.field.required')}
              </Checkbox>
              <Button
                variant="ghost"
                icon="trash"
                aria-label={
                  field.name
                    ? t('settings.lookups.field.remove', { name: field.name })
                    : t('settings.lookups.field.removeThis')
                }
                title={t('settings.lookups.field.removeTip')}
                onClick={() => setDraft(d => ({ ...d, fields: d.fields.filter((_, i) => i !== index) }))}
              />
            </div>
          ))}
          <Button
            size="sm"
            icon="plus"
            disabled={draft.fields.length >= LOOKUP_FIELDS_MAX}
            onClick={() => setDraft(d => ({ ...d, fields: [...d.fields, emptyField()] }))}
          >
            {t('settings.lookups.field.add')}
          </Button>
        </div>
      </Field>
      {error && <Note tone="danger">{error}</Note>}
    </Dialog>
  )
}
