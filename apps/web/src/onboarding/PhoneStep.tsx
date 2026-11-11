// Step 2: connect a number the assistant answers, then (for a number the business keeps) the forwarding code.
import type { PhoneNumber } from '@linedesk/db/types'
import { useEffect, useState } from 'react'
import type { PhoneSetupStatus } from '../auth.ts'
import { Field, TextInput } from '../settings/fields.tsx'
import { useRows, useRun } from '../store.tsx'
import { RadioCard } from '../ui/controls.tsx'
import { Button, cx, Icon } from '../ui/kit.tsx'
import { CopyButton, Foot, useStepKeys } from './Frame.tsx'
import { buyQuestion, carriers, formatNumber, forwardingDigits, phoneSetupInput, priceNote, type PhoneChoice } from './flow.ts'

type Props = {
  status: PhoneSetupStatus
  setupError: string | null
  clearError: () => void
  onBack: () => void
  onNext: () => void
}

const providerLabel = (provider: string | null) =>
  provider === 'twilio' ? 'Twilio' : provider === 'telnyx' ? 'Telnyx' : null

export function PhoneStep(p: Props) {
  const number = useRows('phone_numbers')[0]
  if (number) return <Connected number={number} onBack={p.onBack} onNext={p.onNext} />
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

function Choose({ status, setupError, clearError, onBack }: Props) {
  const run = useRun()
  // Numbers already in the install's carrier account are for instance admins only: then only a new one.
  const canAttach = status?.canAttach !== false
  const [kind, setKind] = useState<PhoneChoice['kind']>(canAttach ? 'existing' : 'new')
  const [typed, setTyped] = useState('')
  const [areaCode, setAreaCode] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const carrier = providerLabel(status.provider)

  // A rejection ends the wait; success shows up as the new phone_numbers row (this screen then unmounts).
  useEffect(() => {
    if (setupError) {
      setSending(false)
      setConfirming(false)
    }
  }, [setupError])

  function send(choice: PhoneChoice) {
    const result = phoneSetupInput(choice)
    if ('problem' in result) return setProblem(result.problem)
    setProblem(null)
    clearError()
    setSending(true)
    void run('phoneNumber.setup', result.input)
  }
  function primary() {
    if (sending) return
    if (kind === 'existing') return send({ kind, number: typed })
    // Buying needs a second, deliberate click: Enter only asks for the confirmation.
    if (!confirming) {
      const check = phoneSetupInput({ kind, areaCode, confirmed: true })
      if ('problem' in check) return setProblem(check.problem)
      setProblem(null)
      setConfirming(true)
    }
  }
  function pick(next: PhoneChoice['kind']) {
    setKind(next)
    setConfirming(false)
    setProblem(null)
  }
  useStepKeys({ onEnter: primary, onEscape: () => (confirming ? setConfirming(false) : onBack()) })

  const error = problem ?? setupError
  return (
    <>
      <div className="ob-body">
        <h1>Which number should your assistant answer?</h1>
        <div className="k-radios" role="radiogroup" aria-label="Phone number">
          {canAttach && (
            <RadioCard
              name="ob-mode"
              checked={kind === 'existing'}
              onPick={() => pick('existing')}
              title={carrier ? `Use a number I have in ${carrier}` : 'Use a number I already have'}
            />
          )}
          <RadioCard name="ob-mode" checked={kind === 'new'} onPick={() => pick('new')} title="Get a new number" />
        </div>
        {status.provider === 'dev' && kind === 'existing' && (
          <p className="ob2-note">Development mode: any number works, nothing is called.</p>
        )}
        {kind === 'existing' ? (
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
            <Field id="ob-area" label="Area code">
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
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={sending}
                    onClick={() => send({ kind: 'new', areaCode, confirmed: true })}
                  >
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
        canContinue={!confirming}
        busy={sending}
        label={sending ? 'Connecting…' : kind === 'existing' ? 'Connect number' : 'Get a number'}
      />
    </>
  )
}

function Connected({ number, onBack, onNext }: { number: PhoneNumber; onBack: () => void; onNext: () => void }) {
  const [carrierId, setCarrierId] = useState(carriers[0]!.id)
  const carrier = carriers.find(c => c.id === carrierId) ?? carriers[0]!
  const code = carrier.on(forwardingDigits(number.e164))
  const forwards = number.mode === 'forward_conditional'
  useStepKeys({ onEnter: onNext, onEscape: onBack })
  return (
    <>
      <div className="ob-body">
        <h1>{forwards ? 'Forward the calls you miss.' : 'Your number is ready.'}</h1>
        <div className="ob-prompt ok">
          <Icon name="check" size={16} />
          <span>Your assistant answers {formatNumber(number.e164)}.</span>
        </div>
        {forwards && (
          <>
            <p className="ob-lede">Keep your business number. Missed and busy calls go to your assistant.</p>
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
            <div className="ob2-dial">
              <span>From your business phone, dial</span>
              <b>{code}</b>
              <CopyButton text={code} label="Copy code" />
              <span>
                Turn it off any time with {carrier.off}. Other carriers: look up "conditional call forwarding".
              </span>
            </div>
          </>
        )}
      </div>
      <Foot onBack={onBack} onContinue={onNext} canContinue />
    </>
  )
}
