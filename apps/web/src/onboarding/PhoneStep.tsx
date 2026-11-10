// Step 2: connect a number the assistant answers, then (for a number the business keeps) the forwarding code.
import type { PhoneNumber } from '@callfront/db/types'
import { useEffect, useState } from 'react'
import type { PhoneSetupStatus } from '../auth.ts'
import { Field, TextInput } from '../settings/fields.tsx'
import { useRows, useRun } from '../store.tsx'
import { Button, cx, Icon } from '../ui/kit.tsx'
import { CopyButton, Foot, useStepKeys } from './Frame.tsx'
import { carriers, formatNumber, forwardingDigits, phoneSetupInput, priceNote, type PhoneChoice } from './flow.ts'

type Props = { status: PhoneSetupStatus; setupError: string | null; clearError: () => void; onBack: () => void; onNext: () => void }

const providerLabel = (provider: string | null) => (provider === 'twilio' ? 'Twilio' : provider === 'telnyx' ? 'Telnyx' : null)

export function PhoneStep(p: Props) {
  const number = useRows('phone_numbers')[0]
  if (number) return <Connected number={number} onBack={p.onBack} onNext={p.onNext} />
  if (p.status.problem) return <Unavailable problem={p.status.problem} onBack={p.onBack} onNext={p.onNext} />
  return <Choose {...p} />
}

function Unavailable({ problem, onBack, onNext }: { problem: string; onBack: () => void; onNext: () => void }) {
  useStepKeys({ onEnter: onNext, onEscape: onBack })
  return (
    <>
      <div className="ob-body">
        <h1>Phone numbers aren't set up on this server yet.</h1>
        <p className="ob-lede">Whoever runs this Linedesk needs to add the carrier keys first. Skip this step for now; your assistant starts answering once a number is connected.</p>
        <p className="ob2-note">Server says: {problem}</p>
      </div>
      <Foot onBack={onBack} onContinue={onNext} canContinue label="Skip for now" />
    </>
  )
}

function Choose({ status, setupError, clearError, onBack }: Props) {
  const run = useRun()
  const [kind, setKind] = useState<PhoneChoice['kind']>('existing')
  const [typed, setTyped] = useState('')
  const [areaCode, setAreaCode] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const carrier = providerLabel(status.provider)

  // A rejection ends the wait; success shows up as the new phone_numbers row (this screen then unmounts).
  useEffect(() => {
    if (setupError) { setSending(false); setConfirming(false) }
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
        <div className="ob-choices" role="radiogroup" aria-label="Phone number">
          <Choice id="existing" on={kind === 'existing'} onPick={pick} title={carrier ? `Use a number I have in ${carrier}` : 'Use a number I already have'}
            text={carrier ? `A number already in your ${carrier} account.` : 'A number already in your carrier account.'} />
          <Choice id="new" on={kind === 'new'} onPick={pick} title="Get a new number" text="A local number in the area code you pick." />
        </div>
        {status.provider === 'dev' && kind === 'existing' && <p className="ob2-note">Development mode: no carrier is connected, so any number works and no real call reaches it.</p>}
        {kind === 'existing' ? (
          <Field id="ob-number" label={carrier ? `Number in ${carrier}` : 'Number'}>
            <TextInput id="ob-number" value={typed} onChange={v => { setTyped(v); setProblem(null); clearError() }} placeholder="(503) 555-0142" />
          </Field>
        ) : (
          <>
            <Field id="ob-area" label="Area code">
              <TextInput id="ob-area" value={areaCode} onChange={v => { setAreaCode(v.replace(/\D/g, '').slice(0, 3)); setConfirming(false); setProblem(null); clearError() }} placeholder="503" />
            </Field>
            <p className="ob2-note">{priceNote(status.provider)}</p>
            {confirming && (
              <div className="ob-prompt" role="alert">
                <span>Buy a number in area code {areaCode}? It is billed every month until you release it.</span>
                <span className="ob2-row">
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={sending}>Cancel</Button>
                  <Button size="sm" variant="primary" disabled={sending} onClick={() => send({ kind: 'new', areaCode, confirmed: true })}>Buy number</Button>
                </span>
              </div>
            )}
          </>
        )}
        {error && <p className="ob-error" role="alert">{error}</p>}
      </div>
      <Foot onBack={onBack} onContinue={primary} canContinue={!confirming} busy={sending}
        label={sending ? 'Connecting…' : kind === 'existing' ? 'Connect number' : 'Get a number'} />
    </>
  )
}

function Choice({ id, on, onPick, title, text }: { id: PhoneChoice['kind']; on: boolean; onPick: (id: PhoneChoice['kind']) => void; title: string; text: string }) {
  return (
    <label className={cx('ob-choice', on && 'on')} htmlFor={`ob-m-${id}`}>
      <input id={`ob-m-${id}`} type="radio" name="ob-mode" checked={on} onChange={() => onPick(id)} />
      <div><b>{title}</b><span>{text}</span></div>
    </label>
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
        <div className="ob-prompt ok"><Icon name="check" size={16} /><span>Your assistant answers {formatNumber(number.e164)}.</span></div>
        {forwards && (
          <>
            <p className="ob-lede">Keep your business number. When nobody picks up or the line is busy, your carrier forwards the call to your assistant.</p>
            <div className="field">
              <span id="ob-carrier-l" className="ob-label">Your carrier</span>
              <div className="ob2-chips" role="radiogroup" aria-labelledby="ob-carrier-l">
                {carriers.map(c => (
                  <button key={c.id} type="button" role="radio" aria-checked={c.id === carrierId} className={cx('ob2-seg', c.id === carrierId && 'on')} onClick={() => setCarrierId(c.id)}>{c.name}</button>
                ))}
              </div>
            </div>
            <div className="ob2-dial">
              <span>From your business phone, dial</span>
              <b>{code}</b>
              <CopyButton text={code} label="Copy code" />
              <span>Turn it off any time with {carrier.off}. Other carriers: look up "conditional call forwarding".</span>
            </div>
          </>
        )}
      </div>
      <Foot onBack={onBack} onContinue={onNext} canContinue />
    </>
  )
}
