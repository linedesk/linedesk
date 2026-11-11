// Step 3: call the number and watch the call arrive through sync; without a number, a test call in the browser.
import { useState } from 'react'
import { TestCall } from '../settings/TestCall.tsx'
import { useAssistantName, useRows } from '../store.tsx'
import { Button, Icon } from '../ui/kit.tsx'
import { LiveIndicator } from '../ui/LiveIndicator.tsx'
import { CopyButton, Foot, useStepKeys } from './Frame.tsx'
import { firstTestCall, formatNumber, simulateCommand } from './flow.ts'

/** Calls that started a little before the screen opened still count (clock drift, a quick dial). */
const SLACK_MS = 2 * 60_000

type Props = { showSimulator: boolean; onBack: () => void; onNext: () => void; onOpenCall: (callId: string) => void }

export function TestCallStep({ showSimulator, onBack, onNext, onOpenCall }: Props) {
  const numbers = useRows('phone_numbers')
  const calls = useRows('calls')
  const name = useAssistantName()
  const [since] = useState(() => new Date(Date.now() - SLACK_MS).toISOString())
  const [simulate, setSimulate] = useState(false)
  const number = numbers[0]
  const call = firstTestCall(
    calls,
    numbers.map(n => n.e164),
    since,
  )
  const answered = call?.status === 'completed'
  useStepKeys({ onEnter: onNext, onEscape: onBack })

  if (!number) {
    return (
      <>
        <div className="ob-body">
          <h1>Talk to {name} in the browser.</h1>
          <p className="ob-lede">Use your microphone and ask what a customer would ask.</p>
          <TestCall canStart />
        </div>
        <Foot onBack={onBack} onContinue={onNext} canContinue label="Continue" />
      </>
    )
  }
  return (
    <>
      <div className="ob-body">
        <h1>Call your number now.</h1>
        <p className="ob-lede">Ask what a customer would ask. The call shows up here.</p>
        <div className="ob2-dial">
          <span>Call</span>
          <b>{formatNumber(number.e164)}</b>
          {!call && (
            <span className="ob2-row">
              <span className="ob2-spin" aria-hidden="true" />
              Waiting for the call…
            </span>
          )}
          {call?.status === 'live' && (
            <span className="ob2-row">
              {name} is on the call <LiveIndicator since={new Date(call.started_at)} />
            </span>
          )}
          {answered && (
            <div className="ob-prompt ok" role="status">
              <Icon name="check" size={16} />
              <span className="ob2-grow">
                It works. {name} answered{' '}
                {call.title ? `"${call.title}"` : `the call from ${formatNumber(call.from_number)}`}.
              </span>
              <Button size="sm" variant="ghost" onClick={() => onOpenCall(call.id)}>
                Open the call
              </Button>
            </div>
          )}
        </div>
        {number.mode === 'forward_conditional' && !call && (
          <p className="ob2-note">Once forwarding is on, a call you miss on your business number reaches {name} too.</p>
        )}
        {showSimulator &&
          !call &&
          (simulate ? (
            <div className="ob2-card ob-sim">
              <span className="ob2-note">
                Development only: plays a scripted call to this number. Nothing real is dialled. Run it where the repo
                is checked out.
              </span>
              <code>{simulateCommand(number.e164)}</code>
              <CopyButton text={simulateCommand(number.e164)} label="Copy command" />
            </div>
          ) : (
            <Button variant="ghost" icon="spark" onClick={() => setSimulate(true)}>
              Simulate a call instead
            </Button>
          ))}
      </div>
      <Foot onBack={onBack} onContinue={onNext} canContinue label={answered ? 'Continue' : 'Skip test call'} />
    </>
  )
}
