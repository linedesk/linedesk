// Assistant settings, Webhook, During the call: what the assistant can ask the business's system on a call
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
import { type FormEvent, useState } from 'react'
import { useRun } from '../store.tsx'
import { Checkbox, Select } from '../ui/controls.tsx'
import { Dialog, Input, Textarea } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { DeleteButton, EditButton, List, ListEmpty, ListRow } from '../ui/list.tsx'
import { Field } from './fields.tsx'
import { callAction } from './settings-api.ts'

const TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Yes or no' },
] as const satisfies readonly { value: LookupFieldType; label: string }[]

const emptyField = (): LookupField => ({ name: '', type: 'text', description: '', required: true })
const emptyLookup = (): WebhookLookup => ({ name: '', when: '', fields: [emptyField()] })

type Props = { endpoint: WebhookEndpoint; toast: (text: string) => void }

/** The toast after a test lookup: what the webhook answered, or why there is nothing. */
export function lookupTestText(result: WebhookTestData): string {
  if (!result.ok) return `Test failed: ${result.error}`
  return result.answer
    ? `Answered ${result.responseStatus}: "${result.answer}"`
    : `Answered ${result.responseStatus}, but with no "answer".`
}

export function WebhookLookups({ endpoint, toast }: Props) {
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
        <span className="help">What the assistant can look up during a call.</span>
        <Button
          size="sm"
          icon="plus"
          disabled={lookups.length >= LOOKUPS_MAX}
          onClick={() => setEditing({ index: null })}
          title={`At most ${LOOKUPS_MAX}`}
        >
          Add lookup
        </Button>
      </div>
      {lookups.length ? (
        <List label="Lookups">
          {lookups.map((lookup, index) => (
            <ListRow
              key={lookup.name}
              title={<code>{lookup.name}</code>}
              sub={lookup.when}
              actions={
                <>
                  <Button
                    busy={testing === lookup.name}
                    size="sm"
                    variant="ghost"
                    disabled={testing !== null}
                    onClick={() => void test(lookup)}
                    title="Ask the webhook now with made-up values"
                  >
                    {testing === lookup.name ? 'Testing…' : 'Test'}
                  </Button>
                  <EditButton name={lookup.name} onClick={() => setEditing({ index })} />
                  <DeleteButton name={lookup.name} onDelete={() => save(lookups.filter((_, i) => i !== index))} />
                </>
              }
            />
          ))}
        </List>
      ) : (
        <ListEmpty>No lookups yet: the assistant asks nothing during calls.</ListEmpty>
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
  const [draft, setDraft] = useState(lookup)
  const [error, setError] = useState<string | null>(null)
  const setField = (index: number, change: Partial<LookupField>) =>
    setDraft(d => ({ ...d, fields: d.fields.map((f, i) => (i === index ? { ...f, ...change } : f)) }))

  function submit(e: FormEvent) {
    e.preventDefault()
    const name = draft.name.trim()
    if (taken.includes(name)) return setError(`There is a lookup ${name} already.`)
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
      title={lookup.name ? `Lookup ${lookup.name}` : 'Add lookup'}
      description='The assistant sends these fields with "hook": "during_call" and "lookup": its name. Answer {"answer": "…"}.'
      size="lg"
      onClose={onClose}
      onSubmit={submit}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!draft.name.trim() || !draft.when.trim()}>
            Save
          </Button>
        </>
      }
    >
      <Field id="lk-name" label="Name" help="Lower case, digits and _, e.g. order_status.">
        <Input
          id="lk-name"
          required
          placeholder="order_status"
          value={draft.name}
          onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
        />
      </Field>
      <Field id="lk-when" label="Use when">
        <Textarea
          id="lk-when"
          rows={2}
          maxLength={LOOKUP_WHEN_MAX}
          placeholder="The caller asks where their order is or when it arrives"
          value={draft.when}
          onChange={e => setDraft(d => ({ ...d, when: e.target.value }))}
        />
      </Field>
      <Field
        label="Fields"
        help="What the assistant asks the caller for and sends. Required ones it gets before it looks up."
      >
        <div className="wh-fields">
          {draft.fields.map((field, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fields have no id; their name is what is being edited
            <div className="wh-field" key={index}>
              <Input
                aria-label="Field name"
                placeholder="order_number"
                value={field.name}
                onChange={e => setField(index, { name: e.target.value })}
              />
              <Select
                label="Type"
                size="sm"
                value={field.type}
                options={TYPES}
                onChange={type => setField(index, { type })}
              />
              <Input
                aria-label="What to ask the caller for"
                placeholder="The order number, 6 digits"
                maxLength={LOOKUP_DESCRIPTION_MAX}
                value={field.description}
                onChange={e => setField(index, { description: e.target.value })}
              />
              <Checkbox checked={field.required} onChange={required => setField(index, { required })}>
                Required
              </Checkbox>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                aria-label={`Remove ${field.name || 'this field'}`}
                title="Remove"
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
            Add field
          </Button>
        </div>
      </Field>
      {error && <Note tone="danger">{error}</Note>}
    </Dialog>
  )
}
