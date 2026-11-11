// Settings, Phone numbers: a short list of the workspace's numbers; Manage opens one (who answers it,
// how it is used, forwarding codes, disconnecting), Add number connects another (attach or buy).
// Connecting runs phoneNumber.setup through the outbox; the new row arrives by sync.
import type { Assistant, PhoneNumber } from '@linedesk/db/types'

type PhoneNumberMode = PhoneNumber['mode']
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
import { confirmsNumber, phoneNumberModes } from '@linedesk/actions'
import { usePresence } from '../shell/presence.ts'
import { useAssistantName, useAssistants, useRejection, useRows, useRun } from '../store.tsx'
import { RadioCard, Select, type SelectOption } from '../ui/controls.tsx'
import { Dialog } from '../ui/form.tsx'
import { Button, cx } from '../ui/kit.tsx'
import { Field, Section, TextInput } from './fields.tsx'

const carrierName = (provider: string | null) =>
  provider === 'twilio' ? 'Twilio' : provider === 'telnyx' ? 'Telnyx' : provider === 'dev' ? 'Development' : null

const modeOptions: SelectOption<PhoneNumberMode>[] = phoneNumberModes.map(mode => ({
  value: mode,
  label: numberModeLabel[mode],
}))

type Props = { canEdit: boolean; status: PhoneSetupStatus | null; isInstanceAdmin: boolean }

/** The assistant that answers a number: its own, else the workspace's first. */
const answeredBy = (number: PhoneNumber, assistants: Assistant[]) =>
  assistants.find(a => a.id === number.assistant_id) ?? assistants[0]

export function PhoneNumbers({ canEdit, status, isInstanceAdmin }: Props) {
  const numbers = useRows('phone_numbers').sort((a, b) => a.created_at.localeCompare(b.created_at))
  const assistants = useAssistants()
  const presence = usePresence()
  const answering = presence.kind === 'answering'
  const [adding, setAdding] = useState(false)
  const [managing, setManaging] = useState<string | null>(null)
  const managed = numbers.find(n => n.id === managing)
  const canAdd = canEdit && !!status?.available
  return (
    <Section
      id="st-phone"
      title="Phone numbers"
      actions={
        canAdd && (
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            Add number
          </Button>
        )
      }
    >
      {canEdit && status && !status.available && (
        <Unavailable detail={status.detail} isInstanceAdmin={isInstanceAdmin} />
      )}
      {numbers.length > 0 ? (
        <ul className="pn-list">
          {numbers.map(n => (
            <li key={n.id} className="pn-row">
              <b className="st-mono">{formatNumber(n.e164)}</b>
              <span className={cx('pn-status', answering && 'is-on')}>{answering ? 'Answering' : 'Not answering'}</span>
              {assistants.length > 1 && <span className="pn-who">{answeredBy(n, assistants)?.name}</span>}
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setManaging(n.id)}
                title={`Manage ${formatNumber(n.e164)}`}
              >
                Manage
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="help">{canEdit ? 'No number yet.' : 'No number yet. Only owners and admins can add one.'}</p>
      )}
      {adding && (
        <Dialog title="Add a number" size="md" onClose={() => setAdding(false)}>
          <ConnectNumber status={status} onDone={() => setAdding(false)} onCancel={() => setAdding(false)} />
        </Dialog>
      )}
      {managed && (
        <ManageNumber number={managed} assistants={assistants} canEdit={canEdit} onClose={() => setManaging(null)} />
      )}
    </Section>
  )
}

function Unavailable({ detail, isInstanceAdmin }: { detail: string | null; isInstanceAdmin: boolean }) {
  return (
    <p className="help" role="status">
      No phone carrier on this server yet.{' '}
      {isInstanceAdmin ? (
        <a className="k-link" href="#admin/providers" title={detail ?? undefined}>
          Connect one in Admin
        </a>
      ) : (
        'Ask whoever runs your Linedesk.'
      )}
    </p>
  )
}

type ManageProps = { number: PhoneNumber; assistants: Assistant[]; canEdit: boolean; onClose: () => void }

/** Everything about one number: how it is used, who answers it, the forwarding codes, and disconnecting it. */
function ManageNumber({ number, assistants, canEdit, onClose }: ManageProps) {
  const run = useRun()
  const [releasing, setReleasing] = useState(false)
  const forwards = number.mode === 'forward_conditional' || number.mode === 'forward_all'
  const carrier = carrierName(number.provider)
  const who = answeredBy(number, assistants)
  return (
    <Dialog
      title={formatNumber(number.e164)}
      description={carrier ? `${carrier}${number.purchased ? ' · bought through Linedesk' : ''}` : undefined}
      onClose={onClose}
      footer={
        !releasing && (
          <>
            {canEdit && (
              <Button variant="ghost" className="k-dialog-foot-start pn-release" onClick={() => setReleasing(true)}>
                {number.purchased ? 'Release…' : 'Disconnect…'}
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </>
        )
      }
    >
      {releasing ? (
        <ReleaseNumber number={number} onCancel={() => setReleasing(false)} />
      ) : (
        <>
          {assistants.length > 1 && (
            <Field id="pn-who" label="Answered by">
              <div>
                <Select
                  id="pn-who"
                  value={who?.id ?? ''}
                  label="Answered by"
                  disabled={!canEdit}
                  options={assistants.map(a => ({ value: a.id, label: a.name }))}
                  onChange={assistantId => void run('phoneNumber.update', { phoneNumberId: number.id, assistantId })}
                />
              </div>
            </Field>
          )}
          <Field id="pn-mode" label="How it's used">
            <div>
              <Select
                id="pn-mode"
                value={number.mode}
                label="How it's used"
                disabled={!canEdit}
                options={modeOptions}
                onChange={mode => void run('phoneNumber.update', { phoneNumberId: number.id, mode })}
              />
            </div>
          </Field>
          {forwards && (
            <Field
              id="pn-codes"
              label="Forwarding codes"
              tip="Dial a code from your business phone. Missed and busy calls then go to your assistant."
            >
              <Forwarding e164={number.e164} />
            </Field>
          )}
        </>
      )}
    </Dialog>
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
