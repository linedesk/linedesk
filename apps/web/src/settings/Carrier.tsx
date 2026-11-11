// Settings, Phone numbers, Carrier: the workspace's numbers use the install's carrier, or the
// business's own Twilio or Telnyx account. Owners and admins only. The credentials go straight to the
// server (carrier.set), never through the outbox, so they are not kept in the browser; a saved secret
// never comes back, it shows as "•••• 1234". Save tests the connection right away (carrier.test, reads only).
import type { CarrierStatusData, CarrierTestData, WorkspaceCarrier } from '@linedesk/actions'
import { carrierFields } from '@linedesk/actions'
import { type FormEvent, useState } from 'react'
import { RadioCard } from '../ui/controls.tsx'
import { Dialog, SecretInput } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import {
  type CarrierDraft,
  carrierInput,
  carrierLabel,
  carrierSummary,
  draftErrors,
  initialDraft,
  isChanged,
  visibleFields,
} from './carrierModel.ts'
import { Field, TextInput } from './fields.tsx'
import { callAction } from './settings-api.ts'
import { useQuery, setQueryData } from '../cachedQuery.ts'

const CARRIER = 'workspace.carrier'
const loadCarrier = () => callAction<CarrierStatusData>('carrier.get')

const choices: { carrier: WorkspaceCarrier; description: string }[] = [
  { carrier: 'default', description: 'Numbers through the carrier this Linedesk is set up with.' },
  { carrier: 'twilio', description: 'Numbers from your Twilio account, billed by Twilio.' },
  { carrier: 'telnyx', description: 'Numbers from your Telnyx account, billed by Telnyx.' },
]

/** The workspace's carrier account; null for members (they cannot read it) and while loading. */
export function useCarrierStatus(canEdit: boolean): CarrierStatusData | null {
  return useQuery(canEdit ? CARRIER : null, loadCarrier).data ?? null
}

/** The Carrier line of the Phone numbers section and its dialog. */
export function CarrierRow() {
  const status = useCarrierStatus(true)
  const [open, setOpen] = useState(false)
  if (!status) return null
  return (
    <div className="pn-carrier">
      <span className="pn-carrier-label">Carrier</span>
      <span className="pn-carrier-value">{carrierSummary(status)}</span>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} title="Change the carrier account">
        Change
      </Button>
      {open && <CarrierDialog status={status} onClose={() => setOpen(false)} />}
    </div>
  )
}

type Phase = 'idle' | 'saving' | 'testing'

function CarrierDialog({ status, onClose }: { status: CarrierStatusData; onClose: () => void }) {
  const [draft, setDraft] = useState<CarrierDraft>(() => initialDraft(status))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState<CarrierTestData | null>(null)
  const changed = isChanged(draft, status)
  const busy = phase !== 'idle'
  const own = draft.carrier !== 'default'
  const stored = (field: string) =>
    draft.carrier === status.carrier ? status.fields.find(f => f.field === field) : undefined

  const update = (change: Partial<CarrierDraft>) => {
    setDraft(d => ({ ...d, ...change }))
    setErrors({})
    setResult(null)
  }
  const setValue = (field: string, value: string) => update({ values: { ...draft.values, [field]: value } })

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    if (changed) {
      const problems = draftErrors(draft)
      setErrors(problems)
      const first = Object.keys(problems)[0]
      if (first) return document.getElementById(`carrier-${first}`)?.focus()
    }
    setResult(null)
    try {
      if (changed) {
        setPhase('saving')
        const saved = await callAction<CarrierStatusData>('carrier.set', carrierInput(draft))
        setQueryData(CARRIER, () => saved)
        setDraft(initialDraft(saved))
        if (saved.carrier === 'default') return onClose()
      }
      setPhase('testing')
      setResult(await callAction<CarrierTestData>('carrier.test'))
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setPhase('idle')
    }
  }

  const primary =
    phase === 'saving' ? 'Saving…' : phase === 'testing' ? 'Testing…' : changed || !own ? 'Save' : 'Test connection'
  return (
    <Dialog
      title="Carrier"
      description="Where this workspace's phone numbers come from."
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {changed ? 'Cancel' : 'Close'}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="carrier-form"
            disabled={busy || (!changed && !own) || !status.canStore}
          >
            {primary}
          </Button>
        </>
      }
    >
      <form id="carrier-form" onSubmit={e => void submit(e)} className="pn-carrier-form">
        <div className="k-radios" role="radiogroup" aria-label="Carrier">
          {choices.map(choice => (
            <RadioCard
              key={choice.carrier}
              name="carrier"
              checked={draft.carrier === choice.carrier}
              onPick={() => update({ carrier: choice.carrier })}
              title={carrierLabel[choice.carrier]}
              description={choice.description}
            />
          ))}
        </div>
        {!status.canStore && own && (
          <p className="help" role="status">
            This server cannot store carrier credentials yet. Ask whoever runs your Linedesk.
          </p>
        )}
        {draft.carrier === 'twilio' && (
          <div className="k-radios" role="radiogroup" aria-label="Twilio sign-in">
            <RadioCard
              name="twilio-auth"
              checked={draft.twilioAuth === 'api_key'}
              onPick={() => update({ twilioAuth: 'api_key' })}
              title="API key"
              description="Recommended: you can revoke it on its own."
            />
            <RadioCard
              name="twilio-auth"
              checked={draft.twilioAuth === 'auth_token'}
              onPick={() => update({ twilioAuth: 'auth_token' })}
              title="Auth token"
            />
          </div>
        )}
        {own &&
          visibleFields(draft).map(field => {
            const spec = carrierFields[draft.carrier as 'twilio' | 'telnyx'][field]!
            const id = `carrier-${field}`
            const saved = stored(field)
            return (
              <Field key={field} id={id} label={spec.label} error={errors[field]}>
                {spec.secret ? (
                  <SecretInput
                    // A new save shows the stored "•••• 1234" again instead of the emptied input.
                    key={`${field}-${status.updatedAt}`}
                    id={id}
                    value={draft.values[field] ?? ''}
                    onChange={value => setValue(field, value)}
                    storedLast4={saved?.set ? (saved.last4 ?? '') : undefined}
                    invalid={!!errors[field]}
                  />
                ) : (
                  <TextInput
                    id={id}
                    value={draft.values[field] ?? ''}
                    onChange={value => setValue(field, value)}
                    invalid={!!errors[field]}
                  />
                )}
              </Field>
            )
          })}
        {result && (
          <p className={result.ok ? 'help pn-carrier-ok' : 'help pn-carrier-error'} role="status">
            {result.message}
          </p>
        )}
      </form>
    </Dialog>
  )
}
