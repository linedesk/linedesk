// Settings, Phone numbers, Carrier: the workspace's numbers use the install's carrier, or the
// business's own Telnyx or Twilio account. Owners and admins only. The credentials go straight to the
// server (carrier.set), never through the outbox, so they are not kept in the browser; a saved secret
// never comes back, it shows as "•••• 1234". Save tests the connection right away (carrier.test, reads only).
import type { CarrierStatusData, CarrierTestData, WorkspaceCarrier } from '@linedesk/actions'
import { carrierFields } from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import { type FormEvent, useState } from 'react'
import { RadioCard } from '../ui/controls.tsx'
import { Dialog, SecretInput } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import {
  type CarrierDraft,
  carrierChoiceText,
  carrierInput,
  carrierLabel,
  carrierPurpose,
  carrierSummary,
  draftErrors,
  existingNumbersText,
  initialDraft,
  isChanged,
  visibleFields,
} from './carrierModel.ts'
import { Field, TextInput } from './fields.tsx'
import { callAction } from './settings-api.ts'
import { useQuery, setQueryData } from '../cachedQuery.ts'
import { brandName } from '../brand.ts'
import { carrierName } from '../onboarding/flow.ts'
import { providerAudience } from '../providerAudience.ts'
import { useRows } from '../store.tsx'

const CARRIER = 'workspace.carrier'
const loadCarrier = () => callAction<CarrierStatusData>('carrier.get')

const choices: readonly WorkspaceCarrier[] = ['default', 'telnyx', 'twilio']

/** The workspace's carrier account; null for members (they cannot read it) and while loading. */
export function useCarrierStatus(canEdit: boolean): CarrierStatusData | null {
  return useQuery(canEdit ? CARRIER : null, loadCarrier).data ?? null
}

/**
 * The carrier as a quiet line under the Phone numbers title, with Change; and its dialog. `serverProvider`: the
 * carrier the session reports, named for the default while the workspace uses it.
 */
export function CarrierLine({ serverProvider = null }: { serverProvider?: string | null }) {
  const t = useT()
  const query = useQuery(CARRIER, loadCarrier)
  const status = query.data ?? null
  const [open, setOpen] = useState(false)
  // While it loads, the line is already in place, so the numbers below it never move down.
  if (!status)
    return (
      <div className="pn-carrier">
        {t('settings.carrier.line.label')}
        <Loading
          what={t('settings.carrier.line.loading')}
          loading
          error={query.error}
          onRetry={() => void query.reload()}
          skeleton={<Skeleton shape="text" width={140} />}
          className="pn-carrier-loading"
        />
      </div>
    )
  return (
    <>
      <p className="pn-carrier">
        <T
          k="settings.carrier.line.value"
          values={{ value: <span className="pn-carrier-value">{carrierSummary(status)}</span> }}
        />
        <button
          type="button"
          className="pn-carrier-change"
          onClick={() => setOpen(true)}
          title={t('settings.carrier.line.changeTip')}
        >
          {t('common.action.change')}
        </button>
      </p>
      {open && (
        <CarrierDialog
          status={status}
          serverProvider={status.carrier === 'default' ? serverProvider : null}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

type Phase = 'idle' | 'saving' | 'testing'

function CarrierDialog({
  status,
  serverProvider,
  onClose,
}: {
  status: CarrierStatusData
  serverProvider: string | null
  onClose: () => void
}) {
  const t = useT()
  const ownAccountNumbers = useRows('phone_numbers').filter(n => n.carrier_account === 'workspace').length
  const [draft, setDraft] = useState<CarrierDraft>(() => initialDraft(status))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState<CarrierTestData | null>(null)
  const changed = isChanged(draft, status)
  const busy = phase !== 'idle'
  const own = draft.carrier !== 'default'
  /** Back to the default carrier deletes the saved credentials: asked once in the dialog before saving. */
  const leavingOwn = changed && !own && status.carrier !== 'default'
  const [confirming, setConfirming] = useState(false)
  const ownName = carrierName(status.carrier) ?? t('settings.carrier.genericName')
  const stored = (field: string) =>
    draft.carrier === status.carrier ? status.fields.find(f => f.field === field) : undefined

  const update = (change: Partial<CarrierDraft>) => {
    setDraft(d => ({ ...d, ...change }))
    setErrors({})
    setResult(null)
    setConfirming(false)
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
    if (leavingOwn && !confirming) return setConfirming(true)
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
    phase === 'saving'
      ? t('common.action.saving')
      : phase === 'testing'
        ? t('settings.carrier.dialog.testing')
        : confirming
          ? t('settings.carrier.dialog.removeKeys', { name: ownName })
          : changed || !own
            ? t('common.action.save')
            : t('settings.carrier.dialog.test')
  return (
    <Dialog
      title={t('settings.carrier.dialog.title')}
      description={carrierPurpose()}
      size="md"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {changed ? t('common.action.cancel') : t('common.action.close')}
          </Button>
          <Button
            busy={busy}
            variant={confirming ? 'danger' : 'primary'}
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
        <div className="k-radios" role="radiogroup" aria-label={t('settings.carrier.dialog.title')}>
          {choices.map(carrier => (
            <RadioCard
              key={carrier}
              name="carrier"
              checked={draft.carrier === carrier}
              onPick={() => update({ carrier })}
              title={carrierLabel[carrier]}
              description={carrierChoiceText(carrier, serverProvider)}
            />
          ))}
        </div>
        <Note tone="info">{existingNumbersText(status.carrier, ownAccountNumbers)}</Note>
        {confirming && (
          <p className="k-field-msg" role="alert">
            {t('settings.carrier.dialog.confirmDefault', { name: ownName, brand: brandName() })}
          </p>
        )}
        {!status.canStore && own && (
          <Note tone="warning" title={t('settings.carrier.noStore.title')}>
            {providerAudience() === 'admin' ? t('settings.carrier.noStore.admin') : t('settings.carrier.noStore.ask')}
          </Note>
        )}
        {draft.carrier === 'twilio' && (
          <div className="k-radios" role="radiogroup" aria-label={t('settings.carrier.twilio.signIn')}>
            <RadioCard
              name="twilio-auth"
              checked={draft.twilioAuth === 'api_key'}
              onPick={() => update({ twilioAuth: 'api_key' })}
              title={t('settings.carrier.twilio.apiKey')}
              description={t('settings.carrier.twilio.apiKeyHelp')}
            />
            <RadioCard
              name="twilio-auth"
              checked={draft.twilioAuth === 'auth_token'}
              onPick={() => update({ twilioAuth: 'auth_token' })}
              title={t('settings.carrier.twilio.authToken')}
            />
          </div>
        )}
        {own &&
          visibleFields(draft).map(field => {
            const spec = carrierFields[draft.carrier as 'twilio' | 'telnyx'][field]!
            const id = `carrier-${field}`
            const saved = stored(field)
            return (
              <Field
                key={field}
                id={id}
                label={spec.label}
                error={errors[field]}
                aside={spec.optional ? t('settings.carrier.optional') : undefined}
              >
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
        {result && <Note tone={result.ok ? 'success' : 'danger'}>{result.message}</Note>}
      </form>
    </Dialog>
  )
}
