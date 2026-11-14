// Settings, Phone numbers: a short list of the workspace's numbers; Manage opens one (which assistant answers it,
// how it is used, forwarding codes, disconnecting), Add number connects another with the onboarding phone step's
// choices and words (keep my number, a new number; a number already in the carrier account behind a quiet link).
// Connecting runs phoneNumber.setup through the outbox; the new row arrives by sync.
import type { Assistant, PhoneNumber } from '@linedesk/db/types'

type PhoneNumberMode = PhoneNumber['mode']
import { type ReactNode, useEffect, useState } from 'react'
import type { PhoneSetupStatus } from '../auth.ts'
import { ForwardingCheck } from '../onboarding/ForwardingCheck.tsx'
import { CarrierPicker, ForwardingSteps, useForwardingGuide } from '../onboarding/ForwardingGuide.tsx'
import { forwardingUnverified, type GuidePickedBy } from '../onboarding/forwarding-check.ts'
import {
  areaCodeOf,
  buyQuestion,
  carrierName,
  existingLinkText,
  firstPickup,
  formatNumber,
  numberModeLabel,
  type PhoneOption,
  phoneOptionSetup,
  phoneOptionText,
  phoneSetupErrorText,
  pickupNumberMode,
  priceNote,
} from '../onboarding/flow.ts'
import { confirmsNumber, forwardingGuideById, phoneNumberModes } from '@linedesk/actions'
import { providerAudience } from '../providerAudience.ts'
import { usePresence } from '../shell/presence.ts'
import { useAssistantName, useAssistants, useClaimedRejection, useRows, useRun } from '../store.tsx'
import { RadioCard, Select, type SelectOption } from '../ui/controls.tsx'
import { Dialog } from '../ui/form.tsx'
import { Button, cx, Note } from '../ui/kit.tsx'
import { List, ListEmpty, ListRow, MenuButton } from '../ui/list.tsx'
import { SkeletonRows, useLoadState } from '../ui/LoadStates.tsx'
import { sectionHash, sectionParts } from '../ui/SettingsLayout.tsx'
import { CarrierLine, useCarrierStatus } from './Carrier.tsx'
import { AreaCodeInput } from './AreaCodeInput.tsx'
import { CarrierNumberInput } from './CarrierNumberInput.tsx'
import { Field, Section, TextInput } from './fields.tsx'
import { useWorkspaceSettings } from './settings-api.ts'
import { brandName } from '../brand.ts'

const modeOptions: SelectOption<PhoneNumberMode>[] = phoneNumberModes.map(mode => ({
  value: mode,
  label: numberModeLabel[mode],
}))

type Props = {
  canEdit: boolean
  status: PhoneSetupStatus | null
  isInstanceAdmin: boolean
}

/** The assistant that answers a number: its own, else the workspace's first. */
const answeredBy = (number: PhoneNumber, assistants: Assistant[]) =>
  assistants.find(a => a.id === number.assistant_id) ?? assistants[0]

export function PhoneNumbers({ canEdit, status: serverStatus, isInstanceAdmin }: Props) {
  // A workspace with its own carrier account can add numbers there, whatever the install has; the
  // session's status may be from before the carrier was changed here.
  const carrier = useCarrierStatus(canEdit)
  const status: PhoneSetupStatus | null =
    carrier && carrier.carrier !== 'default'
      ? {
          provider: carrier.carrier,
          available: carrier.sipReady,
          detail: null,
          canAttach: true,
        }
      : serverStatus
  const numbers = useRows('phone_numbers').sort((a, b) => a.created_at.localeCompare(b.created_at))
  const numbersLoad = useLoadState('phone_numbers')
  const calls = useRows('calls')
  const assistants = useAssistants()
  const presence = usePresence()
  const answering = presence.kind === 'answering'
  const [adding, setAdding] = useState(false)
  /** The number whose dialog is open, and whether it opens on releasing it. */
  const [managing, setManaging] = useState<{
    id: string
    release: boolean
  } | null>(null)
  const managed = numbers.find(n => n.id === managing?.id)
  // A link to one number (`#settings/phone/<id>`, from the assistant's page) opens its dialog once the numbers are
  // loaded; the address then names the section only, so closing the dialog or reloading does not open it again.
  const linkedNumber = numbers.find(n => n.id === sectionParts('workspace', window.location.hash).item)?.id
  useEffect(() => {
    if (!linkedNumber) return
    setManaging({ id: linkedNumber, release: false })
    window.history.replaceState(null, '', sectionHash('workspace', 'phone'))
  }, [linkedNumber])
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
      {canEdit && <CarrierLine serverProvider={serverStatus?.provider ?? null} />}
      {canEdit && status && !status.available && (
        <Unavailable
          detail={status.detail}
          isInstanceAdmin={isInstanceAdmin}
          ownCarrier={!!carrier && carrier.carrier !== 'default'}
        />
      )}
      {numbersLoad !== 'ready' ? (
        <SkeletonRows label="Loading phone numbers" rows={1} />
      ) : numbers.length > 0 ? (
        <List label="Phone numbers">
          {numbers.map(n => (
            <ListRow
              key={n.id}
              title={<span className="st-mono">{formatNumber(n.e164)}</span>}
              sub={`${answeredBy(n, assistants)?.name ?? 'The assistant'} · ${numberModeLabel[n.mode]}`}
              aside={
                // Forwarding nobody has seen work yet (the go-live checklist's rule): not "Answering" until it is,
                // and the check is in the number's dialog.
                forwardingUnverified(n, calls) ? (
                  <button
                    type="button"
                    className="pn-status pn-status-link"
                    title="Check the forwarding of this number"
                    onClick={() => setManaging({ id: n.id, release: false })}
                  >
                    Forwarding not verified
                  </button>
                ) : (
                  <span className={cx('pn-status', answering && 'is-on')}>
                    {answering ? 'Answering' : 'Not answering'}
                  </span>
                )
              }
              actions={
                <MenuButton
                  title={`Actions for ${formatNumber(n.e164)}`}
                  items={[
                    {
                      id: 'manage',
                      label: canEdit ? 'Manage…' : 'Details…',
                      onSelect: () => setManaging({ id: n.id, release: false }),
                    },
                    ...(canEdit
                      ? [
                          {
                            id: 'release',
                            label: n.purchased ? 'Release…' : 'Disconnect…',
                            danger: true,
                            onSelect: () => setManaging({ id: n.id, release: true }),
                          },
                        ]
                      : []),
                  ]}
                />
              }
            />
          ))}
        </List>
      ) : (
        <ListEmpty>{canEdit ? 'No number yet.' : 'No number yet. Only owners and admins can add one.'}</ListEmpty>
      )}
      {adding && (
        <Dialog title="Add a number" size="md" onClose={() => setAdding(false)}>
          <ConnectNumber
            status={status}
            onDone={added => {
              setAdding(false)
              // A number the business phone forwards to: its forwarding codes are the next thing to do.
              if (added.mode === 'forward_conditional' || added.mode === 'forward_all')
                setManaging({ id: added.id, release: false })
            }}
            onCancel={() => setAdding(false)}
          />
        </Dialog>
      )}
      {managed && (
        <ManageNumber
          number={managed}
          assistants={assistants}
          canEdit={canEdit}
          release={managing?.release}
          onClose={() => setManaging(null)}
        />
      )}
    </Section>
  )
}

type UnavailableProps = {
  detail: string | null
  isInstanceAdmin: boolean
  ownCarrier: boolean
}

function Unavailable({ detail, isInstanceAdmin, ownCarrier }: UnavailableProps) {
  return (
    <p className="help" role="status">
      {/* With its own carrier account only the server's side can be missing (where calls are sent). */}
      {ownCarrier ? 'This server cannot connect numbers yet.' : 'No phone carrier on this server yet.'}{' '}
      {isInstanceAdmin ? (
        <a className="k-link" href="#admin/providers/telephony" title={detail ?? undefined}>
          Connect one in Admin › Providers
        </a>
      ) : (
        'Ask whoever runs this server.'
      )}
    </p>
  )
}

type ManageProps = {
  number: PhoneNumber
  assistants: Assistant[]
  canEdit: boolean
  /** Opens on releasing (or disconnecting) the number, from the row's menu. */
  release?: boolean
  onClose: () => void
}

/** Everything about one number: how it is used, who answers it, the forwarding codes, and disconnecting it. */
function ManageNumber({ number, assistants, canEdit, release = false, onClose }: ManageProps) {
  const run = useRun()
  const [releasing, setReleasing] = useState(canEdit && release)
  const forwards = number.mode === 'forward_conditional' || number.mode === 'forward_all'
  const carrier = carrierName(number.provider)
  const who = answeredBy(number, assistants)
  const [guideId, setGuideId, pickedByOwner] = useForwardingGuide(number.id)
  return (
    <Dialog
      title={formatNumber(number.e164)}
      description={
        carrier
          ? `${carrier}${number.carrier_account === 'workspace' ? ' · your own account' : ''}${number.purchased ? ` · bought through ${brandName()}` : ''}`
          : undefined
      }
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
            <Field id="pn-who" label="Assistant" help="Which assistant answers this number">
              <div>
                <Select
                  id="pn-who"
                  value={who?.id ?? ''}
                  label="Assistant"
                  disabled={!canEdit}
                  options={assistants.map(a => ({
                    value: a.id,
                    label: a.name,
                  }))}
                  onChange={assistantId =>
                    void run('phoneNumber.update', {
                      phoneNumberId: number.id,
                      assistantId,
                    })
                  }
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
                onChange={mode =>
                  void run('phoneNumber.update', {
                    phoneNumberId: number.id,
                    mode,
                  })
                }
              />
            </div>
          </Field>
          {forwards && (
            <CheckWhenEditing number={number} canEdit={canEdit} onCarrier={setGuideId} pickedByOwner={pickedByOwner}>
              <Field
                id="pn-codes"
                label="Call forwarding"
                tip={
                  number.mode === 'forward_all'
                    ? 'Set it up once on your business phone or phone system. From then on, every call goes to your assistant.'
                    : "Set it up once on your business phone or phone system. From then on, calls you don't answer or can't take because you're on the line go to your assistant."
                }
              >
                <Forwarding
                  guideId={guideId}
                  onGuide={setGuideId}
                  e164={number.e164}
                  mode={number.mode === 'forward_all' ? 'forward_all' : 'forward_conditional'}
                />
              </Field>
            </CheckWhenEditing>
          )}
        </>
      )}
    </Dialog>
  )
}

/**
 * The forwarding codes in the order of the check: owners and admins enter the business number first (its lookup picks
 * the carrier), then the codes, then "Check forwarding". Others see only the codes.
 */
function CheckWhenEditing({
  number,
  canEdit,
  onCarrier,
  pickedByOwner,
  children,
}: {
  number: PhoneNumber
  canEdit: boolean
  onCarrier: (guideId: string, by?: GuidePickedBy) => void
  pickedByOwner: string | null
  children: ReactNode
}) {
  if (!canEdit) return children
  return (
    <ForwardingCheck number={number} onCarrier={onCarrier} pickedByOwner={pickedByOwner}>
      {children}
    </ForwardingCheck>
  )
}

/**
 * Disconnecting a number is the one place Settings asks first: a released number cannot be bought
 * back, so the number has to be typed. The row disappears through sync once the server is done.
 */
function ReleaseNumber({ number, onCancel }: { number: PhoneNumber; onCancel: () => void }) {
  const run = useRun()
  const name = useAssistantName()
  const [typed, setTyped] = useState('')
  const [sent, setSent] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const carrier = carrierName(number.provider) ?? 'the carrier'
  const formatted = formatNumber(number.e164)
  // Shown here, not also as a toast.
  const { rejection, clearRejection } = useClaimedRejection('phoneNumber.release', sent)
  useEffect(() => {
    if (!sent || !rejection) return
    setSent(false)
    setProblem(releaseErrorText(rejection.error))
    clearRejection()
  }, [rejection, sent, clearRejection])

  function release() {
    if (!confirmsNumber(typed, number.e164) || sent) return
    setProblem(null)
    setSent(true)
    void run('phoneNumber.release', {
      phoneNumberId: number.id,
      confirm: typed,
    })
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
          : `${name} stops answering it. The number stays in your ${carrier === 'the carrier' ? 'carrier' : carrier} account.${number.carrier_account === 'workspace' ? ` It is taken off ${brandName()}'s routing there and stops answering until you route it again.` : ''}${number.mode === 'forward_conditional' || number.mode === 'forward_all' ? ' Turn off call forwarding on your business phone too.' : ''}`}
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
      {problem && <Note tone="danger">{problem}</Note>}
      <div className="st-connect-foot">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={sent}>
          Cancel
        </Button>
        <Button
          busy={sent}
          type="submit"
          size="sm"
          variant="danger"
          disabled={sent || !confirmsNumber(typed, number.e164)}
        >
          {sent ? (bought ? 'Releasing…' : 'Disconnecting…') : bought ? 'Release number' : 'Disconnect number'}
        </Button>
      </div>
    </form>
  )
}

/** A `phoneNumber.release` refusal in plain words. */
function releaseErrorText(error: string): string {
  if (/is the carrier in use/i.test(error))
    return `This number belongs to another carrier than the one this server uses now. ${providerAudience() === 'admin' ? 'Switch the carrier back under Admin › Providers to release it.' : 'Ask whoever runs it.'}`
  if (/to confirm/i.test(error)) return 'The number you typed does not match.'
  return `The carrier did not release the number. Nothing changed. (${error})`
}

/** The forwarding instructions for the number's mode (conditional or all calls), per carrier or phone system. */
function Forwarding({
  guideId,
  onGuide,
  e164,
  mode,
}: {
  guideId: string | null
  onGuide: (guideId: string) => void
  e164: string
  mode: 'forward_conditional' | 'forward_all'
}) {
  const guide = guideId ? forwardingGuideById(guideId) : undefined
  return (
    <div className="st-codes">
      <CarrierPicker
        id={`pn-carrier-${e164}`}
        label="Your carrier or phone system"
        value={guideId}
        onChange={onGuide}
      />
      {guide ? (
        <ForwardingSteps guide={guide} mode={mode} e164={e164} compact />
      ) : (
        <p className="help">Pick your carrier or phone system to see how to forward.</p>
      )}
    </div>
  )
}

/** The cards everyone sees: the same as the onboarding phone step (#517): keep my number first, a new number second. */
const connectOptions: readonly PhoneOption[] = ['forward', 'new']

function ConnectNumber({
  status,
  onDone,
  onCancel,
}: {
  status: PhoneSetupStatus | null
  /** The number just connected, once its row has arrived. */
  onDone: (added: PhoneNumber) => void
  onCancel?: () => void
}) {
  const run = useRun()
  const name = useAssistantName()
  const numbers = useRows('phone_numbers')
  const count = numbers.length
  // Numbers already in the install's carrier account are for instance admins only: only they see the link to it.
  const canAttach = status?.canAttach !== false
  const [option, setOption] = useState<PhoneOption>(connectOptions[0]!)
  const [typed, setTyped] = useState('')
  const businessPhone = (useAssistants()[0]?.business_profile as { phone?: string } | undefined)?.phone
  // Like onboarding: the business phone's area code, else that of a number the workspace already has.
  const [areaCode, setAreaCode] = useState(() => areaCodeOf(businessPhone, ...numbers.map(n => n.e164)))
  const [confirming, setConfirming] = useState(false)
  const [sentAt, setSentAt] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const carrier = carrierName(status?.provider ?? null)
  // A refusal while this waits is shown here, not also as a toast.
  const { rejection, clearRejection } = useClaimedRejection('phoneNumber.setup', sentAt !== null)
  // The business's number forwards as chosen for pick-up (Settings › Hours); until loaded, the calls it misses.
  const forwarding = pickupNumberMode(firstPickup(useWorkspaceSettings().data ?? null))
  const buying = option !== 'existing'
  const dev = status?.provider === 'dev'

  // Success is the new row arriving by sync; a refusal ends the wait with its reason.
  useEffect(() => {
    if (sentAt === null || count <= sentAt) return
    setSentAt(null)
    const added = [...numbers].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    if (added) onDone(added)
  }, [count, sentAt, numbers, onDone])
  useEffect(() => {
    if (!rejection || sentAt === null) return
    setSentAt(null)
    setConfirming(false)
    setProblem(phoneSetupErrorText(rejection.error))
    clearRejection()
  }, [rejection, sentAt, clearRejection])

  function send(confirmed: boolean) {
    const result = phoneOptionSetup(option, { number: typed, areaCode, confirmed }, forwarding)
    if ('problem' in result) return setProblem(result.problem)
    setProblem(null)
    setSentAt(count)
    void run('phoneNumber.setup', result.input)
  }
  function submit() {
    if (sentAt !== null) return
    if (!buying) return send(false)
    // Buying needs a second, deliberate click: Enter only asks for the confirmation.
    const check = phoneOptionSetup(option, { number: typed, areaCode, confirmed: true }, forwarding)
    if ('problem' in check) return setProblem(check.problem)
    setProblem(null)
    setConfirming(true)
  }
  const pick = (next: PhoneOption) => {
    setOption(next)
    setConfirming(false)
    setProblem(null)
  }
  const busy = sentAt !== null
  const existing = phoneOptionText('existing', name, carrier)

  return (
    <form
      className="st-connect"
      onSubmit={e => {
        e.preventDefault()
        submit()
      }}
    >
      {option === 'existing' ? (
        <div className="st-pn-t">
          <b>{existing.title}</b>
          <span className="help">{existing.description}</span>
        </div>
      ) : (
        <>
          <div className="k-radios" role="radiogroup" aria-label="Phone number">
            {connectOptions.map(o => (
              <RadioCard
                key={o}
                name="st-pn-kind"
                checked={option === o}
                onPick={() => pick(o)}
                {...phoneOptionText(o, name, carrier)}
              />
            ))}
          </div>
          {canAttach && (
            <div>
              <Button size="sm" variant="ghost" onClick={() => pick('existing')}>
                {existingLinkText(carrier)}
              </Button>
            </div>
          )}
        </>
      )}
      {option === 'existing' ? (
        <>
          <Field id="st-pn-number" label={carrier ? `Number in ${carrier}` : 'Number'}>
            <CarrierNumberInput
              id="st-pn-number"
              value={typed}
              onChange={v => {
                setTyped(v)
                setProblem(null)
              }}
              placeholder="The number, with area code"
            />
          </Field>
          {dev && <p className="help">Development mode: any number works, nothing is called.</p>}
          <div>
            <Button size="sm" variant="ghost" onClick={() => pick(connectOptions[0]!)}>
              Back to the choices
            </Button>
          </div>
        </>
      ) : (
        <>
          <Field
            id="st-pn-area"
            label={option === 'forward' ? `Area code for ${name}'s number` : 'Area code'}
            help={priceNote(status?.provider ?? null)}
          >
            <AreaCodeInput
              id="st-pn-area"
              value={areaCode}
              onChange={v => {
                setAreaCode(v)
                setConfirming(false)
                setProblem(null)
              }}
            />
          </Field>
          {confirming && (
            <div className="ob-prompt" role="alert">
              <span>{buyQuestion(status?.provider ?? null, areaCode)}</span>
              <span className="ob2-row">
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button busy={busy} size="sm" variant="primary" disabled={busy} onClick={() => send(true)}>
                  {busy ? 'Buying…' : dev ? 'Add test number' : 'Buy number'}
                </Button>
              </span>
            </div>
          )}
        </>
      )}
      {problem && <Note tone="danger">{problem}</Note>}
      {!confirming && (
        <div className="st-connect-foot">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
          <Button busy={busy} type="submit" size="sm" variant="primary" disabled={busy}>
            {busy ? 'Connecting…' : buying ? (dev ? 'Add a test number' : 'Get a number') : 'Connect number'}
          </Button>
        </div>
      )}
    </form>
  )
}
