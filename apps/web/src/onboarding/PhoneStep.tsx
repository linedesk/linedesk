// The phone step: connect a number the assistant answers, then (for a number the business keeps) the forwarding code.
// It leads with keeping the business's number: a new number to give out reaches the assistant only when dialled.
import type { PhoneNumber } from '@linedesk/db/types'
import { useEffect, useState } from 'react'
import type { PhoneSetupStatus } from '../auth.ts'
import { useDefaultPhoneCountry } from '../phoneCountry.ts'
import { AreaCodeInput } from '../settings/AreaCodeInput.tsx'
import { CarrierNumberInput } from '../settings/CarrierNumberInput.tsx'
import { Field } from '../settings/fields.tsx'
import { useWorkspaceSettings, useWriteAction } from '../settings/settings-api.ts'
import { useAssistant, useAssistantName, useRows, useRun } from '../store.tsx'
import { RadioCard } from '../ui/controls.tsx'
import { Button, Icon, Note } from '../ui/kit.tsx'
import { ForwardingCheck } from './ForwardingCheck.tsx'
import { AbroadWarning, ForwardingSteps, GuidePickers, useForwardingPick } from './ForwardingGuide.tsx'
import { Foot, useStepKeys } from './Frame.tsx'
import {
  areaCodeOf,
  buyQuestion,
  carrierName,
  existingLinkText,
  firstPickup,
  formatNumber,
  forwardingOffer,
  type PhoneOption,
  phoneOptionSetup,
  phoneOptions,
  phoneOptionText,
  pickupNumberMode,
  priceNote,
  turnOffFirst,
  URGENT_CONTACT_ID,
} from './flow.ts'

type Props = {
  status: PhoneSetupStatus
  /** How the number forwarded before the pick-up step changed it this session: its off code is shown first. */
  oldForwarding: 'forward_conditional' | 'forward_all' | null
  /** The business phone given in the first step: prefills the business number of the forwarding check. */
  businessNumber?: string
  setupError: string | null
  clearError: () => void
  /** An instance admin: hints about the server link to Server admin › Providers; everyone else is told whom to ask. */
  admin: boolean
  onBack: () => void
  onNext: () => void
}

/** A number is never skipped, only connected later: it stays in the go-live checklist. */
const LATER = { laterLabel: 'Connect later', laterTitle: 'It stays in your go-live checklist' }

export function PhoneStep(p: Props) {
  const number = useRows('phone_numbers')[0]
  const assistant = useAssistant()
  // The business phone from step 1 (#491 saves it in the profile) and the owner's mobile from step 4.
  const businessPhone = (assistant?.business_profile as { phone?: string } | undefined)?.phone ?? null
  const mobile = assistant?.transfers.find(c => c.id === URGENT_CONTACT_ID)?.number ?? null
  if (number)
    return (
      <Connected
        number={number}
        oldForwarding={p.oldForwarding}
        // The business phone from step 1 prefills the forwarding check's business-number field.
        businessNumber={p.businessNumber ?? businessPhone ?? undefined}
        onBack={p.onBack}
        onNext={p.onNext}
      />
    )
  if (!p.status.available)
    return <Unavailable detail={p.status.detail} admin={p.admin} onBack={p.onBack} onNext={p.onNext} />
  return <Choose {...p} firstAreaCode={areaCodeOf(businessPhone, mobile)} />
}

function Unavailable({
  detail,
  admin,
  onBack,
  onNext,
}: {
  detail: string | null
  admin: boolean
  onBack: () => void
  onNext: () => void
}) {
  useStepKeys({ onEnter: onNext, onEscape: onBack })
  return (
    <>
      <div className="ob-body">
        <h1>No phone carrier on this server yet.</h1>
        <p className="ob-lede">
          Connect your number later: it stays in your go-live checklist.{' '}
          {/* The same as Settings › Phone numbers: admins get the place to fix it, everyone else whom to ask. */}
          {admin ? (
            <a className="k-link" href="#admin/providers/telephony" title={detail ?? undefined}>
              Connect a carrier in Server admin › Providers
            </a>
          ) : (
            'Ask whoever runs this server.'
          )}
        </p>
      </div>
      <Foot onBack={onBack} onContinue={onNext} canContinue label={LATER.laterLabel} />
    </>
  )
}

function Choose({ status, setupError, clearError, onBack, onNext, firstAreaCode }: Props & { firstAreaCode: string }) {
  const run = useRun()
  const name = useAssistantName()
  // Numbers already in the install's carrier account are for instance admins only: only they see the link to it.
  const canAttach = status?.canAttach !== false
  const [option, setOption] = useState<PhoneOption>(phoneOptions[0]!)
  // E.164 as far as typed (PhoneInput). No number is connected yet, so no forwarding guide has picked a country.
  const [typed, setTyped] = useState('')
  const phoneCountry = useDefaultPhoneCountry()
  // Prefilled from a number the owner already gave; empty otherwise (no example that looks filled in).
  const [areaCode, setAreaCode] = useState(firstAreaCode)
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const carrier = carrierName(status.provider)
  // The business's number forwards as chosen on the pick-up step; until the settings are loaded, the calls it misses
  // (the default choice).
  const pickup = firstPickup(useWorkspaceSettings().data ?? null)
  const forwarding = pickupNumberMode(pickup)
  const buying = option !== 'existing'
  const dev = status.provider === 'dev'

  // A rejection ends the wait; success shows up as the new phone_numbers row (this screen then unmounts).
  useEffect(() => {
    if (setupError) {
      setSending(false)
      setConfirming(false)
    }
  }, [setupError])

  function send(confirmed: boolean) {
    const result = phoneOptionSetup(option, { number: typed, areaCode, confirmed }, forwarding)
    if ('problem' in result) return setProblem(result.problem)
    setProblem(null)
    clearError()
    setSending(true)
    void run('phoneNumber.setup', result.input)
  }
  function primary() {
    if (sending) return
    if (!buying) return send(false)
    // Buying needs a second, deliberate click: Enter only asks for the confirmation.
    if (!confirming) {
      const check = phoneOptionSetup(option, { number: typed, areaCode, confirmed: true }, forwarding)
      if ('problem' in check) return setProblem(check.problem)
      setProblem(null)
      setConfirming(true)
    }
  }
  function pick(next: PhoneOption) {
    setOption(next)
    setConfirming(false)
    setProblem(null)
  }
  const toChoices = () => pick(phoneOptions[0]!)
  useStepKeys({
    onEnter: primary,
    onEscape: () => (confirming ? setConfirming(false) : option === 'existing' ? toChoices() : onBack()),
  })

  const error = problem ?? setupError
  const existing = phoneOptionText('existing', name, carrier)
  return (
    <>
      <div className="ob-body">
        <h1>
          {forwarding === 'forward_all'
            ? 'Keep your number, forward your calls.'
            : 'Keep your number, forward the calls you miss.'}
        </h1>
        <p className="ob-lede">
          Callers keep dialing the number they know, and{' '}
          {forwarding === 'forward_all' ? 'every call' : 'the calls you miss'} reach {name}.
        </p>
        {option === 'existing' ? (
          <div className="ob-existing">
            <b>{existing.title}</b>
            <span className="ob2-note">{existing.description}</span>
          </div>
        ) : (
          <>
            <div className="k-radios" role="radiogroup" aria-label="Phone number">
              {phoneOptions.map(o => (
                <RadioCard
                  key={o}
                  name="ob-mode"
                  checked={option === o}
                  onPick={() => pick(o)}
                  {...phoneOptionText(o, name, carrier)}
                />
              ))}
            </div>
            {canAttach && (
              <button type="button" className="ob-link" onClick={() => pick('existing')}>
                {existingLinkText(carrier)}
              </button>
            )}
          </>
        )}
        {dev && option === 'existing' && (
          <p className="ob2-note">Development mode: any number works, nothing is called.</p>
        )}
        {option === 'existing' ? (
          <>
            <Field id="ob-number" label={carrier ? `Number in ${carrier}` : 'Number'}>
              <CarrierNumberInput
                id="ob-number"
                value={typed}
                onChange={v => {
                  setTyped(v)
                  setProblem(null)
                  clearError()
                }}
                defaultCountry={phoneCountry}
              />
            </Field>
            <button type="button" className="ob-link" onClick={toChoices} title="Back to the choices (Esc)">
              Back to the choices
            </button>
          </>
        ) : (
          <>
            <Field id="ob-area" label={option === 'forward' ? `Area code for ${name}'s number` : 'Area code'}>
              <AreaCodeInput
                id="ob-area"
                value={areaCode}
                onChange={v => {
                  setAreaCode(v)
                  setConfirming(false)
                  setProblem(null)
                  clearError()
                }}
              />
            </Field>
            <p className="ob2-note">{priceNote(status.provider)}</p>
            {confirming && (
              <div className="ob-prompt" role="alert">
                <span>{buyQuestion(status.provider, areaCode)}</span>
                <span className="ob2-row">
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={sending}>
                    Cancel
                  </Button>
                  <Button size="sm" variant="primary" busy={sending} onClick={() => send(true)}>
                    {dev ? 'Add test number' : 'Buy number'}
                  </Button>
                </span>
              </div>
            )}
          </>
        )}
        {error && <Note tone="danger">{error}</Note>}
      </div>
      <Foot
        onBack={onBack}
        onContinue={primary}
        onSkipStep={onNext}
        {...LATER}
        canContinue={!confirming}
        busy={sending && !confirming}
        label={buying ? (dev ? 'Add a test number' : 'Get a number') : 'Connect number'}
      />
    </>
  )
}

/** Whether this page load already told the server the forwarding code was shown. */
let forwardingShownSent = false

function Connected({
  number,
  oldForwarding,
  businessNumber,
  onBack,
  onNext,
}: {
  number: PhoneNumber
  oldForwarding: Props['oldForwarding']
  businessNumber?: string
  onBack: () => void
  onNext: () => void
}) {
  // No carrier is assumed: until the owner picks one or the lookup finds it, the picker is empty and no codes show.
  const {
    country,
    setCountry,
    guide: carrier,
    guideId: carrierId,
    setGuide: setCarrierId,
    pickedByOwner,
  } = useForwardingPick(number)
  const all = number.mode === 'forward_all'
  const forwards = all || number.mode === 'forward_conditional'
  // The pick-up choice changed after the code was shown: an old forwarding that is still on must go first.
  const oldOff =
    carrier && oldForwarding && oldForwarding !== number.mode
      ? turnOffFirst(carrier, oldForwarding, number.e164, country)
      : null
  const name = useAssistantName()
  const run = useRun()
  const write = useWriteAction()
  // A new number given out: calls to the business's current number don't reach the assistant unless it forwards too.
  const offer = forwardingOffer(number.mode, firstPickup(useWorkspaceSettings().data ?? null))
  const [forwardProblem, setForwardProblem] = useState<string | null>(null)
  function forwardToo() {
    if (!offer) return
    setForwardProblem(null)
    // The mode change syncs back as the row's mode: this screen then shows the forwarding code.
    write('phoneNumber.update', { phoneNumberId: number.id, mode: offer }).catch(() =>
      setForwardProblem("Couldn't switch on forwarding. Try again in a moment."),
    )
  }
  // For the setup funnel: how many reach the forwarding code. The server keeps only the first time, so once per page load is enough.
  useEffect(() => {
    if (!forwards || forwardingShownSent) return
    forwardingShownSent = true
    void run('onboarding.recordEvent', { event: 'forwarding_instructions_shown' })
  }, [forwards, run])
  useStepKeys({ onEnter: onNext, onEscape: onBack })
  return (
    <>
      <div className="ob-body">
        <h1>{all ? 'Forward your calls.' : forwards ? 'Forward the calls you miss.' : 'Your number is ready.'}</h1>
        <div className="ob-prompt ok">
          <Icon name="check" size={16} />
          <span>
            {name} answers {formatNumber(number.e164)}.
          </span>
        </div>
        {offer && (
          <>
            <p className="ob-lede">
              Only calls to {formatNumber(number.e164)} reach {name}. Calls to your current number ring as they do
              today.
            </p>
            <div className="ob2-row">
              <Button variant="secondary" onClick={forwardToo}>
                {offer === 'forward_all'
                  ? 'Forward my current number to it too'
                  : 'Forward the calls I miss on my current number too'}
              </Button>
            </div>
            {forwardProblem && <Note tone="danger">{forwardProblem}</Note>}
          </>
        )}
        {forwards && (
          <>
            <p className="ob-lede">
              {all
                ? `Keep your business number. Every call goes to ${name}.`
                : `Keep your business number. Missed and busy calls go to ${name}.`}
            </p>
            <ForwardingCheck
              number={number}
              businessNumber={businessNumber}
              onCarrier={setCarrierId}
              pickedByOwner={pickedByOwner}
              lookupOnOpen
            >
              <div className="field">
                <label htmlFor="ob-carrier" className="ob-label">
                  Your carrier or phone system
                </label>
                <GuidePickers
                  id="ob-carrier"
                  country={country}
                  onCountry={setCountry}
                  guideId={carrierId}
                  onGuide={setCarrierId}
                />
              </div>
              <AbroadWarning e164={number.e164} country={country} guide={carrier} />
              {oldOff && (
                <p className="ob2-note" role="status">
                  {oldOff}
                </p>
              )}
              {carrier ? (
                <ForwardingSteps
                  guide={carrier}
                  mode={all ? 'forward_all' : 'forward_conditional'}
                  e164={number.e164}
                  country={country}
                />
              ) : (
                <p className="ob2-note">Pick your carrier or phone system to see how to forward.</p>
              )}
            </ForwardingCheck>
          </>
        )}
      </div>
      <Foot onBack={onBack} onContinue={onNext} canContinue />
    </>
  )
}
