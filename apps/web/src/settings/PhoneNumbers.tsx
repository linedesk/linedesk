// Settings, Phone numbers: the numbers the assistant answers, how to forward a business line to
// them, and connecting another one (attach a number from the carrier account, or buy one).
// Connecting runs phoneNumber.setup through the outbox; the new row arrives by sync.
import type { PhoneNumber } from '@linedesk/db/types'
import { useEffect, useState } from 'react'
import type { PhoneSetupStatus } from '../auth.ts'
import { CopyButton } from '../onboarding/Frame.tsx'
import {
  carriers,
  forwardingDigits,
  formatNumber,
  numberModeLabel,
  phoneSetupErrorText,
  phoneSetupInput,
  priceNote,
  type PhoneChoice,
} from '../onboarding/flow.ts'
import { confirmsNumber } from '@linedesk/actions'
import { usePresence } from '../shell/presence.ts'
import { useAssistantName, useRejection, useRows, useRun } from '../store.tsx'
import { RadioCard } from '../ui/controls.tsx'
import { Badge, Button, cx } from '../ui/kit.tsx'
import { Field, Section, TextInput } from './fields.tsx'

const carrierName = (provider: string | null) =>
  provider === 'twilio' ? 'Twilio' : provider === 'telnyx' ? 'Telnyx' : null

type Props = { canEdit: boolean; status: PhoneSetupStatus | null; isInstanceAdmin: boolean }

export function PhoneNumbers({ canEdit, status, isInstanceAdmin }: Props) {
  const numbers = useRows('phone_numbers').sort((a, b) => a.created_at.localeCompare(b.created_at))
  const name = useAssistantName()
  const presence = usePresence()
  const answering = presence.kind === 'answering'
  const [adding, setAdding] = useState(false)
  const showForm = canEdit && status?.available && (numbers.length === 0 || adding)
  return (
    <Section
      id="st-phone"
      title="Phone numbers"
      description={
        !numbers.length
          ? `Connect a number and ${name} answers its calls.`
          : presence.kind === 'notAnswering'
            ? `${name} answers once the voice service is set up.`
            : `${name} answers calls to these numbers.`
      }
    >
      {numbers.length > 0 && (
        <div className="st-list">
          {numbers.map(n => (
            <NumberRow key={n.id} number={n} canEdit={canEdit} answering={answering} />
          ))}
        </div>
      )}
      {!canEdit && numbers.length === 0 && (
        <p className="help">No number yet. Only owners and admins can connect one.</p>
      )}
      {canEdit && status && !status.available && (
        <Unavailable detail={status.detail} isInstanceAdmin={isInstanceAdmin} />
      )}
      {showForm && (
        <ConnectNumber
          status={status}
          onDone={() => setAdding(false)}
          onCancel={numbers.length ? () => setAdding(false) : undefined}
        />
      )}
      {canEdit && status?.available && numbers.length > 0 && !adding && (
        <div>
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            Add a number
          </Button>
        </div>
      )}
    </Section>
  )
}

function Unavailable({ detail, isInstanceAdmin }: { detail: string | null; isInstanceAdmin: boolean }) {
  return (
    <div className="st-note" role="status">
      <b>No phone carrier on this server yet.</b>
      <span className="help">
        {isInstanceAdmin ? (
          <>
            {detail ? `${detail}. ` : ''}
            <a className="k-link" href="#admin/providers">
              Connect one in Admin
            </a>
          </>
        ) : (
          'Ask whoever runs your Linedesk to connect one.'
        )}
      </span>
    </div>
  )
}

/** "Answering" only when calls are really answered (the header's status); a checked number is "Connected". */
function NumberStatus({ number, answering }: { number: PhoneNumber; answering: boolean }) {
  if (answering) return <Badge dot>Answering</Badge>
  if (number.verified_at) return <Badge>Connected</Badge>
  return <Badge>Not tested yet</Badge>
}

function NumberRow({ number, canEdit, answering }: { number: PhoneNumber; canEdit: boolean; answering: boolean }) {
  const forwards = number.mode === 'forward_conditional' || number.mode === 'forward_all'
  const [open, setOpen] = useState(false)
  const [releasing, setReleasing] = useState(false)
  return (
    <div className="st-li st-pn">
      <div className="st-pn-head">
        <div className="st-pn-t">
          <b className="st-mono">{formatNumber(number.e164)}</b>
          <span className="help">
            {numberModeLabel[number.mode]}
            {carrierName(number.provider) ? ` · ${carrierName(number.provider)}` : ''}
          </span>
        </div>
        <NumberStatus number={number} answering={answering} />
        {forwards && (
          <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(o => !o)}>
            {open ? 'Hide forwarding' : 'Forwarding codes'}
          </Button>
        )}
        {canEdit && !releasing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setReleasing(true)}
            title={number.purchased ? 'Release this number' : 'Disconnect this number'}
          >
            {number.purchased ? 'Release…' : 'Disconnect…'}
          </Button>
        )}
      </div>
      {forwards && open && <Forwarding e164={number.e164} />}
      {releasing && <ReleaseNumber number={number} onCancel={() => setReleasing(false)} />}
    </div>
  )
}

/**
 * Disconnecting a number is the one place Settings asks first: a released number cannot be bought
 * back, so the number has to be typed. The row disappears through sync once the server is done.
 */
function ReleaseNumber({ number, onCancel }: { number: PhoneNumber; onCancel: () => void }) {
  const run = useRun()
  const name = useAssistantName()
  const { rejection } = useRejection()
  const [typed, setTyped] = useState('')
  const [sent, setSent] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const carrier = carrierName(number.provider) ?? 'the carrier'
  const formatted = formatNumber(number.e164)
  useEffect(() => {
    if (!sent || rejection?.action !== 'phoneNumber.release') return
    setSent(false)
    setProblem(releaseErrorText(rejection.error))
  }, [rejection, sent])

  function release() {
    if (!confirmsNumber(typed, number.e164) || sent) return
    setProblem(null)
    setSent(true)
    void run('phoneNumber.release', { phoneNumberId: number.id, confirm: typed })
  }
  const bought = number.purchased && number.provider !== 'dev'
  return (
    <form
      className="st-release"
      role="alertdialog"
      aria-labelledby={`rel-${number.id}`}
      onSubmit={e => {
        e.preventDefault()
        release()
      }}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      <b id={`rel-${number.id}`}>{bought ? `Release ${formatted}?` : `Disconnect ${formatted}?`}</b>
      <span className="help">
        {bought
          ? `${name} stops answering it and the number goes back to ${carrier}. Its monthly cost stops, and you cannot get the number back.`
          : `${name} stops answering it. The number stays in your ${carrier === 'the carrier' ? 'carrier' : carrier} account.${number.mode === 'forward_conditional' || number.mode === 'forward_all' ? ' Turn off call forwarding on your business phone too.' : ''}`}
      </span>
      <Field id={`rel-in-${number.id}`} label="Type the number to confirm">
        <TextInput
          id={`rel-in-${number.id}`}
          value={typed}
          onChange={v => {
            setTyped(v)
            setProblem(null)
          }}
          placeholder={formatted}
        />
      </Field>
      {problem && (
        <p className="auth-error" role="alert">
          {problem}
        </p>
      )}
      <div className="st-connect-foot">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={sent}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="danger" disabled={sent || !confirmsNumber(typed, number.e164)}>
          {sent ? (bought ? 'Releasing…' : 'Disconnecting…') : bought ? 'Release number' : 'Disconnect number'}
        </Button>
      </div>
    </form>
  )
}

/** A `phoneNumber.release` refusal in plain words. */
function releaseErrorText(error: string): string {
  if (/is the carrier in use/i.test(error))
    return 'This number belongs to another carrier than the one this Linedesk uses now. Ask whoever runs your Linedesk.'
  if (/to confirm/i.test(error)) return 'The number you typed does not match.'
  return `The carrier did not release the number. Nothing changed. (${error})`
}

/** Conditional call forwarding codes per carrier, to dial from the business line. */
function Forwarding({ e164 }: { e164: string }) {
  const [carrierId, setCarrierId] = useState(carriers[0]!.id)
  const carrier = carriers.find(c => c.id === carrierId) ?? carriers[0]!
  const on = carrier.on(forwardingDigits(e164))
  return (
    <div className="st-codes">
      <div className="st-seg" role="radiogroup" aria-label="Your carrier">
        {carriers.map(c => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={c.id === carrierId}
            className={cx('st-seg-b', c.id === carrierId && 'on')}
            onClick={() => setCarrierId(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="st-code">
        <span className="help">Turn on</span>
        <code>{on}</code>
        <CopyButton text={on} />
      </div>
      <div className="st-code">
        <span className="help">Turn off</span>
        <code>{carrier.off}</code>
        <CopyButton text={carrier.off} />
      </div>
      <span className="help">Dial it from your business phone. Missed and busy calls then go to your assistant.</span>
    </div>
  )
}

function ConnectNumber({
  status,
  onDone,
  onCancel,
}: {
  status: PhoneSetupStatus | null
  onDone: () => void
  onCancel?: () => void
}) {
  const run = useRun()
  const count = useRows('phone_numbers').length
  const { rejection } = useRejection()
  const [kind, setKind] = useState<PhoneChoice['kind']>('existing')
  const [typed, setTyped] = useState('')
  const [areaCode, setAreaCode] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [sentAt, setSentAt] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const carrier = carrierName(status?.provider ?? null)

  // Success is the new row arriving by sync; a refusal ends the wait with its reason.
  useEffect(() => {
    if (sentAt !== null && count > sentAt) {
      setSentAt(null)
      onDone()
    }
  }, [count, sentAt, onDone])
  useEffect(() => {
    if (rejection?.action !== 'phoneNumber.setup' || sentAt === null) return
    setSentAt(null)
    setConfirming(false)
    setProblem(phoneSetupErrorText(rejection.error))
  }, [rejection, sentAt])

  function send(choice: PhoneChoice) {
    const result = phoneSetupInput(choice)
    if ('problem' in result) return setProblem(result.problem)
    setProblem(null)
    setSentAt(count)
    void run('phoneNumber.setup', result.input)
  }
  function submit() {
    if (sentAt !== null) return
    if (kind === 'existing') return send({ kind, number: typed })
    const check = phoneSetupInput({ kind, areaCode, confirmed: true })
    if ('problem' in check) return setProblem(check.problem)
    setProblem(null)
    setConfirming(true)
  }
  const pick = (next: PhoneChoice['kind']) => {
    setKind(next)
    setConfirming(false)
    setProblem(null)
  }
  const busy = sentAt !== null

  return (
    <form
      className="st-connect"
      onSubmit={e => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="k-radios" role="radiogroup" aria-label="Which number">
        <RadioCard
          name="st-pn-kind"
          checked={kind === 'existing'}
          onPick={() => pick('existing')}
          title={carrier ? `Use a number I have in ${carrier}` : 'Use a number I already have'}
          description={
            carrier ? `A number already in your ${carrier} account.` : 'A number already in your carrier account.'
          }
        />
        <RadioCard
          name="st-pn-kind"
          checked={kind === 'new'}
          onPick={() => pick('new')}
          title="Get a new number"
          description="A local number in the area code you pick."
        />
      </div>
      {kind === 'existing' ? (
        <Field id="st-pn-number" label={carrier ? `Number in ${carrier}` : 'Number'}>
          <TextInput
            id="st-pn-number"
            value={typed}
            onChange={v => {
              setTyped(v)
              setProblem(null)
            }}
            placeholder="+1 503 555 0142"
          />
        </Field>
      ) : (
        <>
          <Field id="st-pn-area" label="Area code" help={priceNote(status?.provider ?? null)}>
            <TextInput
              id="st-pn-area"
              value={areaCode}
              onChange={v => {
                setAreaCode(v.replace(/\D/g, '').slice(0, 3))
                setConfirming(false)
                setProblem(null)
              }}
              placeholder="503"
            />
          </Field>
          {confirming && (
            <div className="ob-prompt" role="alert">
              <span>Buy a number in {areaCode}? It is billed monthly until you release it.</span>
              <span className="ob2-row">
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => send({ kind: 'new', areaCode, confirmed: true })}
                >
                  {busy ? 'Buying…' : 'Buy number'}
                </Button>
              </span>
            </div>
          )}
        </>
      )}
      {status?.provider === 'dev' && <p className="help">Development mode: nothing is bought or called.</p>}
      {problem && (
        <p className="auth-error" role="alert">
          {problem}
        </p>
      )}
      {!confirming && (
        <div className="st-connect-foot">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
          <Button type="submit" size="sm" variant="primary" disabled={busy}>
            {busy ? 'Connecting…' : kind === 'existing' ? 'Connect number' : 'Get a number'}
          </Button>
        </div>
      )}
    </form>
  )
}
