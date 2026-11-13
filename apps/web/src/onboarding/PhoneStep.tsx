// The phone step: connect a number the assistant answers, then (for a number the business keeps) the forwarding code.
// It leads with keeping the business's number: a new number to give out reaches the assistant only when dialled.
import type { PhoneNumber } from '@linedesk/db/types'
import { useEffect, useState } from 'react'
import type { PhoneSetupStatus } from '../auth.ts'
import { Field, TextInput } from '../settings/fields.tsx'
import { useWorkspaceSettings, useWriteAction } from '../settings/settings-api.ts'
import { useAssistantName, useRows, useRun } from '../store.tsx'
import { RadioCard } from '../ui/controls.tsx'
import { Button, cx, Icon } from '../ui/kit.tsx'
import { CopyButton, Foot, useStepKeys } from './Frame.tsx'
import {
  buyQuestion,
  carrierName,
  carriers,
  firstPickup,
  formatNumber,
  forwardingCode,
  forwardingOffer,
  type PhoneOption,
  phoneOptions,
  phoneOptionSetup,
  phoneOptionText,
  pickupNumberMode,
  priceNote,
} from './flow.ts'

type Props = {
  status: PhoneSetupStatus
  /** How the number forwarded before the pick-up step changed it this session: its off code is shown first. */
  oldForwarding: 'forward_conditional' | 'forward_all' | null
  setupError: string | null
  clearError: () => void
  onBack: () => void
  onNext: () => void
}

export function PhoneStep(p: Props) {
  const number = useRows('phone_numbers')[0]
  if (number) return <Connected number={number} oldForwarding={p.oldForwarding} onBack={p.onBack} onNext={p.onNext} />
  if (!p.status.available) return <Unavailable detail={p.status.detail} onBack={p.onBack} onNext={p.onNext} />
  return <Choose {...p} />
}

function Unavailable({ detail, onBack, onNext }: { detail: string | null; onBack: () => void; onNext: () => void }) {
  useStepKeys({ onEnter: onNext, onEscape: onBack })
  return (
    <>
      <div className="ob-body">
        <h1>No phone carrier on this server yet.</h1>
        <p className="ob-lede">Skip for now and connect one later in Settings.</p>
        {detail && <p className="ob2-note">For admins: {detail}. Connect one in Admin, Providers.</p>}
      </div>
      <Foot onBack={onBack} onContinue={onNext} canContinue label="Skip for now" />
    </>
  )
}

function Choose({ status, setupError, clearError, onBack, onNext }: Props) {
  const run = useRun()
  const name = useAssistantName()
  // Numbers already in the install's carrier account are for instance admins only.
  const options = phoneOptions(status?.canAttach !== false)
  const [option, setOption] = useState<PhoneOption>(options[0]!)
  const [typed, setTyped] = useState('')
  const [areaCode, setAreaCode] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const carrier = carrierName(status.provider)
  // The business's number forwards as chosen on the pick-up step; until the settings are loaded, the calls it misses
  // (the default choice).
  const pickup = firstPickup(useWorkspaceSettings().data ?? null)
  const forwarding = pickupNumberMode(pickup)
  const buying = option !== 'existing'

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
  useStepKeys({ onEnter: primary, onEscape: () => (confirming ? setConfirming(false) : onBack()) })

  const error = problem ?? setupError
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
        <div className="k-radios" role="radiogroup" aria-label="Phone number">
          {options.map(o => (
            <RadioCard
              key={o}
              name="ob-mode"
              checked={option === o}
              onPick={() => pick(o)}
              {...phoneOptionText(o, name, carrier)}
            />
          ))}
        </div>
        {status.provider === 'dev' && option === 'existing' && (
          <p className="ob2-note">Development mode: any number works, nothing is called.</p>
        )}
        {option === 'existing' ? (
          <Field id="ob-number" label={carrier ? `Number in ${carrier}` : 'Number'}>
            <TextInput
              id="ob-number"
              value={typed}
              onChange={v => {
                setTyped(v)
                setProblem(null)
                clearError()
              }}
              placeholder="+1 503 555 0100"
            />
          </Field>
        ) : (
          <>
            <Field id="ob-area" label={option === 'forward' ? `Area code for ${name}'s number` : 'Area code'}>
              <TextInput
                id="ob-area"
                value={areaCode}
                onChange={v => {
                  setAreaCode(v.replace(/\D/g, '').slice(0, 3))
                  setConfirming(false)
                  setProblem(null)
                  clearError()
                }}
                placeholder="503"
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
                  <Button size="sm" variant="primary" disabled={sending} onClick={() => send(true)}>
                    Buy number
                  </Button>
                </span>
              </div>
            )}
          </>
        )}
        {error && (
          <p className="ob-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <Foot
        onBack={onBack}
        onContinue={primary}
        onSkipStep={onNext}
        canContinue={!confirming}
        busy={sending}
        label={sending ? 'Connecting…' : buying ? 'Get a number' : 'Connect number'}
      />
    </>
  )
}

/** Whether this page load already told the server the forwarding code was shown. */
let forwardingShownSent = false

function Connected({
  number,
  oldForwarding,
  onBack,
  onNext,
}: {
  number: PhoneNumber
  oldForwarding: Props['oldForwarding']
  onBack: () => void
  onNext: () => void
}) {
  const [carrierId, setCarrierId] = useState(carriers[0]!.id)
  const carrier = carriers.find(c => c.id === carrierId) ?? carriers[0]!
  const all = number.mode === 'forward_all'
  const forwards = all || number.mode === 'forward_conditional'
  const code = forwardingCode(carrier, number.mode, number.e164)
  // The pick-up choice changed after the code was shown: an old forwarding that is still on must go first.
  const oldOff =
    oldForwarding && oldForwarding !== number.mode ? forwardingCode(carrier, oldForwarding, number.e164).off : null
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
            {forwardProblem && (
              <p className="ob-error" role="alert">
                {forwardProblem}
              </p>
            )}
          </>
        )}
        {forwards && (
          <>
            <p className="ob-lede">
              {all
                ? `Keep your business number. Every call goes to ${name}.`
                : `Keep your business number. Missed and busy calls go to ${name}.`}
            </p>
            <div className="field">
              <span id="ob-carrier-l" className="ob-label">
                Your carrier
              </span>
              <div className="ob2-chips" role="radiogroup" aria-labelledby="ob-carrier-l">
                {carriers.map(c => (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={c.id === carrierId}
                    className={cx('ob2-seg', c.id === carrierId && 'on')}
                    onClick={() => setCarrierId(c.id)}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
            {oldOff && (
              <p className="ob2-note" role="status">
                Dialled the earlier code already? Turn that forwarding off first with {oldOff}.
              </p>
            )}
            <div className="ob2-dial">
              <span>From your business phone, dial</span>
              <b>{code.on}</b>
              <CopyButton text={code.on} label="Copy code" />
              <span>
                Turn it off any time with {code.off}. Other carriers: look up "
                {all ? 'call forwarding' : 'conditional call forwarding'}".
              </span>
            </div>
          </>
        )}
      </div>
      <Foot onBack={onBack} onContinue={onNext} canContinue />
    </>
  )
}
