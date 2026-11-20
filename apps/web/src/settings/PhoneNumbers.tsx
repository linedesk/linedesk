// Settings, Phone numbers: a short list of the workspace's numbers; Manage opens one (which assistant answers it,
// how it is used, forwarding codes, disconnecting), Add number connects another in two steps: get a new number (its
// monthly price; a number already in the carrier account behind a quiet link), then whether the current number forwards
// to it. Connecting runs phoneNumber.setup through the outbox; the new row arrives by sync. Where a number can be bought
// comes from the install's buy offers (the phone setup status), the same list as onboarding's.
import type { Assistant, PhoneNumber } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { type ReactNode, useEffect, useState } from 'react'
import type { PhoneSetupStatus } from '../auth.ts'
import { ForwardingCheck } from '../onboarding/ForwardingCheck.tsx'
import { AbroadWarning, ForwardingSteps, GuidePickers, useForwardingPick } from '../onboarding/ForwardingGuide.tsx'
import { forwardingUnverified, type GuidePickedBy } from '../onboarding/forwarding-check.ts'
import {
  areaCodeIn,
  areaCodeOf,
  beingSetUpText,
  billedExtraNumberCents,
  billedNumberNote,
  billedNumberPrice,
  buyOffersOf,
  buyQuestion,
  buyingCountry,
  buyUnavailableText,
  carrierName,
  existingLinkText,
  firstPickup,
  formatNumber,
  numberModeLabel,
  offersBuying,
  type PhoneOption,
  phoneOptionSetup,
  phoneOptionText,
  isNoneFreeText,
  numberCharge,
  numbersBeingSetUp,
  phoneSetupErrorText,
  pickupNumberMode,
  priceCountry,
  priceNote,
} from '../onboarding/flow.ts'
import {
  areaCodeShown,
  BASE_BUY_OFFERS,
  buyableAreaCode,
  buyOfferIn,
  confirmsNumber,
  countryOfNumber,
  offerAreaCodes,
  offerHasAreaCode,
  phoneFromValue,
} from '@linedesk/actions'
import { useDefaultPhoneCountry } from '../phoneCountry.ts'
import { providerAudience } from '../providerAudience.ts'
import { usePresence } from '../shell/presence.ts'
import { useAssistantName, useAssistants, useClaimedRejection, useRows, useRun } from '../store.tsx'
import { RadioCard, Select } from '../ui/controls.tsx'
import { Dialog } from '../ui/form.tsx'
import { AppLink } from '../ui/AppLink.tsx'
import { Badge, Button, Note } from '../ui/kit.tsx'
import { StatusMark } from '../ui/StatusMark.tsx'
import { List, ListEmpty, ListRow, MenuButton } from '../ui/list.tsx'
import { PhoneInput } from '../ui/PhoneInput.tsx'
import { Loading, SkeletonList, useLoadState } from '../ui/LoadStates.tsx'
import { sectionHash, sectionParts } from '../ui/SettingsLayout.tsx'
import { CarrierLine, useCarrierStatus } from './Carrier.tsx'
import { AreaCodeInput } from './AreaCodeInput.tsx'
import { NearbyAreaCodes } from './NearbyAreaCodes.tsx'
import { CarrierNumberInput } from './CarrierNumberInput.tsx'
import { Field, Section } from './fields.tsx'
import { NumberModeField } from './NumberMode.tsx'
import { useWorkspaceSettings } from './settings-api.ts'
import { useWorkspaceCountry } from '../workspaceLocale.ts'
import { brandName } from '../brand.ts'
import { i18n } from '../i18n/index.tsx'

type Props = {
  canEdit: boolean
  status: PhoneSetupStatus | null
  isInstanceAdmin: boolean
  /** On a bill: what each number beyond the included one costs a month (from the balance); null otherwise. */
  extraNumberCents?: number | null
}

/** The assistant that answers a number: its own, else the workspace's first. */
const answeredBy = (number: PhoneNumber, assistants: Assistant[]) =>
  assistants.find(a => a.id === number.assistant_id) ?? assistants[0]

export function PhoneNumbers({ canEdit, status: serverStatus, isInstanceAdmin, extraNumberCents = null }: Props) {
  const t = useT()
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
          account: 'workspace',
          // A workspace's own carrier account buys where every install does (Germany only on the install's).
          buy: [...BASE_BUY_OFFERS],
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
      title={t('settings.phone.title')}
      actions={
        canAdd && (
          <Button size="sm" icon="plus" onClick={() => setAdding(true)}>
            {t('settings.phone.add')}
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
      <Loading
        what={t('settings.phone.what')}
        loading={numbersLoad !== 'ready'}
        error={numbersLoad === 'slow'}
        skeleton={<SkeletonList rows={1} aside action />}
      >
        {numbers.length > 0 ? (
          <List label={t('settings.phone.title')}>
            {numbers.map(n => (
              <ListRow
                key={n.id}
                title={<span className="st-mono">{formatNumber(n.e164)}</span>}
                sub={t('settings.phone.row.sub', {
                  assistant: answeredBy(n, assistants)?.name ?? t('settings.phone.row.theAssistant'),
                  mode: numberModeLabel[n.mode],
                })}
                aside={
                  // Forwarding nobody has seen work yet (the go-live checklist's rule): not "Answering" until it is,
                  // and the check is in the number's dialog.
                  forwardingUnverified(n, calls) ? (
                    <button
                      type="button"
                      className="pn-status-link"
                      title={t('settings.phone.row.checkTip')}
                      onClick={() => setManaging({ id: n.id, release: false })}
                    >
                      <Badge>
                        <StatusMark state="untested" label={t('settings.phone.row.unverified')} />
                        {t('settings.phone.row.unverified')}
                      </Badge>
                    </button>
                  ) : answering ? (
                    <Badge tone="ok">
                      <StatusMark state="works" label={t('settings.phone.row.answering')} />
                      {t('settings.phone.row.answering')}
                    </Badge>
                  ) : (
                    <Badge>
                      <StatusMark state="off" label={t('settings.phone.row.notAnswering')} />
                      {t('settings.phone.row.notAnswering')}
                    </Badge>
                  )
                }
                actions={
                  <MenuButton
                    title={t('settings.phone.row.actions', { number: formatNumber(n.e164) })}
                    items={[
                      {
                        id: 'manage',
                        label: canEdit ? t('settings.phone.row.manage') : t('settings.phone.row.details'),
                        onSelect: () => setManaging({ id: n.id, release: false }),
                      },
                      ...(canEdit
                        ? [
                            {
                              id: 'release',
                              label: n.purchased
                                ? t('settings.phone.release.menu')
                                : t('settings.phone.disconnect.menu'),
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
          <ListEmpty>{canEdit ? t('settings.phone.empty') : t('settings.phone.emptyMember')}</ListEmpty>
        )}
      </Loading>
      {adding && (
        <Dialog title={t('settings.phone.addTitle')} size="md" onClose={() => setAdding(false)}>
          <ConnectNumber
            status={status}
            // The workspace's own carrier account is not billed by us: its numbers cost what that carrier charges.
            extraNumberCents={billedExtraNumberCents(extraNumberCents, status)}
            onDone={() => setAdding(false)}
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
  const t = useT()
  return (
    <p className="help" role="status">
      {/* With its own carrier account only the server's side can be missing (where calls are sent). */}
      {ownCarrier ? t('settings.phone.unavailable.ownCarrier') : t('settings.phone.unavailable.noCarrier')}{' '}
      {isInstanceAdmin ? (
        <AppLink to="#admin/providers/telephony" title={detail ?? undefined}>
          {t('settings.phone.unavailable.connect')}
        </AppLink>
      ) : (
        t('settings.phone.unavailable.ask')
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

/**
 * Everything about one number: how it is used, who answers it, the forwarding codes, and disconnecting it. Also opened
 * from the agent setup page's Call forwarding row (onboarding/SetupRowActions.tsx).
 */
export function ManageNumber({ number, assistants, canEdit, release = false, onClose }: ManageProps) {
  const t = useT()
  const run = useRun()
  const [releasing, setReleasing] = useState(canEdit && release)
  const forwards = number.mode === 'forward_conditional' || number.mode === 'forward_all'
  const carrier = carrierName(number.provider)
  const who = answeredBy(number, assistants)
  const pick = useForwardingPick(number)
  return (
    <Dialog
      title={formatNumber(number.e164)}
      description={
        carrier
          ? t('settings.phone.manage.description', {
              carrier,
              own: number.carrier_account === 'workspace',
              bought: number.purchased,
              brand: brandName(),
            })
          : undefined
      }
      onClose={onClose}
      footer={
        !releasing && (
          <>
            {canEdit && (
              <Button variant="ghost" className="k-dialog-foot-start pn-release" onClick={() => setReleasing(true)}>
                {number.purchased ? t('settings.phone.release.menu') : t('settings.phone.disconnect.menu')}
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              {t('settings.phone.manage.done')}
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
            <Field
              id="pn-who"
              label={t('settings.phone.manage.assistant')}
              tip={t('settings.phone.manage.assistantTip')}
            >
              <div>
                <Select
                  id="pn-who"
                  value={who?.id ?? ''}
                  label={t('settings.phone.manage.assistant')}
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
          <NumberModeField
            mode={number.mode}
            name={who?.name ?? t('common.assistant.unnamed')}
            disabled={!canEdit}
            onChange={mode =>
              void run('phoneNumber.update', {
                phoneNumberId: number.id,
                mode,
              })
            }
          />
          {forwards && (
            <CheckWhenEditing
              number={number}
              canEdit={canEdit}
              onCarrier={pick.setGuide}
              pickedByOwner={pick.pickedByOwner}
            >
              <Field
                id="pn-codes"
                label={t('settings.phone.manage.forwarding')}
                tip={
                  number.mode === 'forward_all'
                    ? t('settings.phone.manage.forwardingAllTip')
                    : t('settings.phone.manage.forwardingConditionalTip')
                }
              >
                <Forwarding
                  pick={pick}
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
  const t = useT()
  const defaultCountry = useDefaultPhoneCountry()
  const run = useRun()
  const name = useAssistantName()
  // E.164 as far as typed (PhoneInput), compared by digits with the number (confirmsNumber), as the server does.
  const [typed, setTyped] = useState('')
  // The field starts in the number's own country, so its digits are typed as written there.
  const phoneCountry = countryOfNumber(number.e164) ?? defaultCountry
  const [sent, setSent] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const carrier = carrierName(number.provider)
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
      <b id={`rel-${number.id}`}>
        {bought
          ? t('settings.phone.release.title', { number: formatted })
          : t('settings.phone.disconnect.title', { number: formatted })}
      </b>
      <span className="help">
        {bought
          ? carrier
            ? t('settings.phone.release.help', { name, carrier })
            : t('settings.phone.release.helpNoCarrier', { name })
          : [
              carrier
                ? t('settings.phone.disconnect.help', { name, carrier })
                : t('settings.phone.disconnect.helpNoCarrier', { name }),
              ...(number.carrier_account === 'workspace'
                ? [t('settings.phone.disconnect.ownAccount', { brand: brandName() })]
                : []),
              ...(number.mode === 'forward_conditional' || number.mode === 'forward_all'
                ? [t('settings.phone.disconnect.forwarding')]
                : []),
            ].join(' ')}
      </span>
      <Field id={`rel-in-${number.id}`} label={t('settings.phone.release.confirmLabel')}>
        <PhoneInput
          id={`rel-in-${number.id}`}
          value={typed}
          defaultCountry={phoneCountry}
          autoComplete="off"
          onChange={v => {
            setTyped(v)
            setProblem(null)
          }}
          placeholder={phoneFromValue(number.e164, phoneCountry).display}
        />
      </Field>
      {problem && <Note tone="danger">{problem}</Note>}
      <div className="st-connect-foot">
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={sent}>
          {t('common.action.cancel')}
        </Button>
        <Button
          busy={sent}
          type="submit"
          size="sm"
          variant="danger"
          disabled={sent || !confirmsNumber(typed, number.e164)}
        >
          {sent
            ? bought
              ? t('settings.phone.release.busy')
              : t('settings.phone.disconnect.busy')
            : bought
              ? t('settings.phone.release.button')
              : t('settings.phone.disconnect.button')}
        </Button>
      </div>
    </form>
  )
}

/** A `phoneNumber.release` refusal in plain words. */
function releaseErrorText(error: string): string {
  const { t } = i18n()
  if (/is the carrier in use/i.test(error))
    return providerAudience() === 'admin'
      ? t('settings.phone.release.error.otherCarrierAdmin')
      : t('settings.phone.release.error.otherCarrier')
  if (/to confirm/i.test(error)) return t('settings.phone.release.error.mismatch')
  return t('settings.phone.release.error.failed', { error })
}

/** The forwarding instructions for the number's mode (conditional or all calls), per carrier or phone system. */
function Forwarding({
  pick,
  e164,
  mode,
}: {
  pick: ReturnType<typeof useForwardingPick>
  e164: string
  mode: 'forward_conditional' | 'forward_all'
}) {
  const t = useT()
  const { guide, country } = pick
  return (
    <div className="st-codes">
      <GuidePickers
        id={`pn-carrier-${e164}`}
        label={t('settings.phone.forwarding.carrier')}
        country={country}
        onCountry={pick.setCountry}
        guideId={pick.guideId}
        onGuide={pick.setGuide}
      />
      <AbroadWarning e164={e164} country={country} guide={guide} />
      {guide ? (
        <ForwardingSteps guide={guide} mode={mode} e164={e164} country={country} compact />
      ) : (
        <p className="help">{t('settings.phone.forwarding.pick')}</p>
      )}
    </div>
  )
}

/** Add number's two steps: get the number (or connect one already in the carrier account), then how calls reach it. */
type ConnectStep = 'buy' | 'existing'

/**
 * Add number, in two steps. Step 1 gets a new number for the assistant: the area code and what it costs a month (from
 * the bill: `extraNumberCents`; else the carrier's list price), with the quiet link to a number already in the carrier
 * account where the member may connect one (canAttach). Buying asks once more and then runs phoneNumber.setup, so the
 * number is bought and saved before step 2: closing the dialog later loses nothing. It is bought as the business's
 * forwarding target (the pick-up choice's mode, the recommended way, as before). Step 2 (ForwardStep) asks whether the
 * business's current number forwards here and saves the answer as the number's mode.
 */
export function ConnectNumber({
  status,
  extraNumberCents = null,
  onDone,
  onCancel,
}: {
  status: PhoneSetupStatus | null
  /** On a bill and the install's carrier account: the extra number's monthly price, said instead of the carrier's. */
  extraNumberCents?: number | null
  /** Step 2 finished (Done). */
  onDone: () => void
  onCancel?: () => void
}) {
  const t = useT()
  const run = useRun()
  const name = useAssistantName()
  const numbers = useRows('phone_numbers')
  const count = numbers.length
  // Numbers already in the carrier account: the server says who may connect one (canAttach: the workspace's own
  // account; the install's, whatever carrier and bill, only for an instance admin). Unknown: not offered.
  const canAttach = status?.canAttach === true
  // Outside the countries numbers can be bought in (the install's buy offers), only a number the business already has
  // (offersBuying). Unknown yet: every buyable area code, and the one picked names the country (buyingCountry).
  const offers = buyOffersOf(status)
  // The country the owner was shown (picked, the listing's, the workspace's, else its hint) when it has a buy offer.
  const country = buyingCountry(useWorkspaceCountry(), offers)
  const offer = buyOfferIn(offers, country)
  const buyable = offersBuying(country, offers)
  const settingUp = numbersBeingSetUp(country, offers)
  const noAreaCode = !offerHasAreaCode(offer)
  const [chosen, setStep] = useState<ConnectStep>('buy')
  const step: ConnectStep = buyable ? chosen : 'existing'
  // Nothing to connect here: no buying, and the carrier account's numbers are not this member's to connect.
  const nothingToConnect = !buyable && !canAttach
  // E.164 as far as typed (PhoneInput).
  const [typed, setTyped] = useState('')
  const phoneCountry = useDefaultPhoneCountry()
  const businessPhone = (useAssistants()[0]?.business_profile as { phone?: string } | undefined)?.phone
  // Like onboarding: the business phone's area code, else that of a number the workspace already has, else the
  // country's first offered code (Germany).
  const [picked, setAreaCode] = useState(() => areaCodeOf(country, businessPhone, ...numbers.map(n => n.e164)))
  // Only a code of the workspace's country (its list): one prefilled while the country loaded is dropped.
  const areaCode = areaCodeIn(picked, country, offers) ? picked : (offer?.areaCodes?.[0] ?? '')
  const [confirming, setConfirming] = useState(false)
  const [sentAt, setSentAt] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  /** The number just connected: step 2. */
  const [addedId, setAddedId] = useState<string | null>(null)
  const added = numbers.find(n => n.id === addedId)
  const carrier = carrierName(status?.provider ?? null)
  // A refusal while this waits is shown here, not also as a toast.
  const { rejection, clearRejection } = useClaimedRejection('phoneNumber.setup', sentAt !== null)
  // The business's number forwards as chosen for pick-up (Settings › Hours); until loaded, the calls it misses.
  const settings = useWorkspaceSettings().data ?? null
  const forwarding = pickupNumberMode(firstPickup(settings))
  const partnerManaged = settings?.partnerManaged === true
  const buying = step === 'buy'
  const dev = status?.provider === 'dev'
  const bought = numbers.filter(n => n.purchased && n.carrier_account === 'install').length
  // A white-label client's people see no prices (docs/white-label.md): its partner pays for the number.
  const monthly = partnerManaged ? null : billedNumberPrice(extraNumberCents, status?.provider ?? null, bought)
  const price = partnerManaged
    ? undefined
    : (billedNumberNote(extraNumberCents, status?.provider ?? null, bought) ??
      priceNote(status?.provider ?? null, priceCountry(areaCode, country)))

  // Success is the new row arriving by sync (then step 2); a refusal ends the wait with its reason.
  useEffect(() => {
    if (sentAt === null || count <= sentAt) return
    setSentAt(null)
    const newest = [...numbers].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    if (newest) setAddedId(newest.id)
  }, [count, sentAt, numbers])
  useEffect(() => {
    if (!rejection || sentAt === null) return
    setSentAt(null)
    setConfirming(false)
    setProblem(phoneSetupErrorText(rejection.error))
    clearRejection()
  }, [rejection, sentAt, clearRejection])

  if (added) return <ForwardStep number={added} name={name} forwarding={forwarding} onDone={onDone} />

  // Step 1 buys as the forwarding target (the `forward` option); the number's mode is settled in step 2.
  const option: PhoneOption = buying ? 'forward' : 'existing'
  function send(confirmed: boolean) {
    const result = phoneOptionSetup(
      option,
      { number: typed, areaCode, confirmed, noAreaCode, offered: offer?.areaCodes },
      forwarding,
    )
    if ('problem' in result) return setProblem(result.problem)
    setProblem(null)
    setSentAt(count)
    void run('phoneNumber.setup', result.input)
  }
  function submit() {
    if (sentAt !== null || nothingToConnect) return
    if (!buying) return send(false)
    // Buying needs a second, deliberate click: Enter only asks for the confirmation.
    const check = phoneOptionSetup(
      option,
      { number: typed, areaCode, confirmed: true, noAreaCode, offered: offer?.areaCodes },
      forwarding,
    )
    if ('problem' in check) return setProblem(check.problem)
    setProblem(null)
    setConfirming(true)
  }
  const go = (next: ConnectStep) => {
    setStep(next)
    setConfirming(false)
    setProblem(null)
  }
  const busy = sentAt !== null
  const existing = phoneOptionText('existing', name, carrier)
  // On a bill the monthly price stands out under the area code; otherwise the carrier's price is the field's help line
  // (or the only line, for a number without an area code).
  const billedLine = monthly && (
    <p className="pn-price">
      <span className="pn-price-amount">{monthly}</span>
      <span className="pn-price-per">{t('settings.phone.connect.perMonth')}</span>
      <span className="help">{t('settings.phone.connect.fromBalance')}</span>
    </p>
  )

  return (
    <form
      className="st-connect pn-connect"
      onSubmit={e => {
        e.preventDefault()
        submit()
      }}
    >
      {nothingToConnect ? (
        // Nothing this member can connect here: only why, and Cancel; no carrier name, no button that does nothing.
        <p className="help" role="status">
          {settingUp ? beingSetUpText() : buyUnavailableText(carrier, canAttach, offers)}
        </p>
      ) : buying ? (
        <div className="st-pn-t">
          <b>{t('settings.phone.connect.buyTitle', { name })}</b>
          <span className="help">{t('settings.phone.connect.buyHelp', { name })}</span>
        </div>
      ) : (
        <div className="st-pn-t">
          <b>{existing.title}</b>
          <span className="help">
            {buyable
              ? existing.description
              : settingUp
                ? beingSetUpText()
                : buyUnavailableText(carrier, canAttach, offers)}
          </span>
        </div>
      )}
      {nothingToConnect ? null : !buying ? (
        <>
          <Field
            id="st-pn-number"
            label={carrier ? t('settings.phone.connect.numberIn', { carrier }) : t('settings.phone.connect.number')}
          >
            <CarrierNumberInput
              id="st-pn-number"
              value={typed}
              onChange={v => {
                setTyped(v)
                setProblem(null)
              }}
              defaultCountry={phoneCountry}
            />
          </Field>
          {dev && <p className="help">{t('settings.phone.connect.dev')}</p>}
          {buyable && (
            <div>
              <Button size="sm" variant="ghost" onClick={() => go('buy')}>
                {t('settings.phone.connect.back')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          {!noAreaCode && (
            <Field id="st-pn-area" label={t('settings.phone.connect.areaCode')} help={monthly ? undefined : price}>
              <AreaCodeInput
                id="st-pn-area"
                openOnFocus={false}
                country={country}
                codes={offer?.areaCodes ? offerAreaCodes(offer) : undefined}
                value={areaCode}
                onChange={v => {
                  setAreaCode(v)
                  setConfirming(false)
                  setProblem(null)
                }}
              />
            </Field>
          )}
          {billedLine || (noAreaCode && price && <p className="help">{price}</p>)}
          {canAttach && (
            <div>
              <Button size="sm" variant="ghost" onClick={() => go('existing')}>
                {existingLinkText(carrier)}
              </Button>
            </div>
          )}
          {confirming && (
            <div className="ob-prompt" role="alert">
              <span>
                {buyQuestion(
                  status?.provider ?? null,
                  noAreaCode ? '' : areaCodeShown(areaCode, country),
                  partnerManaged ? null : numberCharge(extraNumberCents, status?.provider ?? null, bought),
                )}
              </span>
              <span className="ob2-row">
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                  {t('common.action.cancel')}
                </Button>
                <Button busy={busy} size="sm" variant="primary" disabled={busy} onClick={() => send(true)}>
                  {busy
                    ? t('settings.phone.connect.buying')
                    : dev
                      ? t('settings.phone.connect.addTest')
                      : t('settings.phone.connect.buy')}
                </Button>
              </span>
            </div>
          )}
        </>
      )}
      {problem && buying && buyableAreaCode(areaCode) && isNoneFreeText(problem) ? (
        <NearbyAreaCodes
          areaCode={areaCode}
          message={problem}
          onPick={code => {
            setAreaCode(code)
            setProblem(null)
            // The next step is the purchase question for that code, as after the primary button.
            setConfirming(true)
          }}
        />
      ) : (
        problem && <Note tone="danger">{problem}</Note>
      )}
      {!confirming && (
        <div className="st-connect-foot">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
              {t('common.action.cancel')}
            </Button>
          )}
          {!nothingToConnect && (
            <Button busy={busy} type="submit" size="sm" variant="primary" disabled={busy}>
              {busy
                ? t('settings.phone.connect.connecting')
                : buying
                  ? dev
                    ? t('settings.phone.connect.addATest')
                    : t('settings.phone.connect.get')
                  : t('settings.phone.connect.connect')}
            </Button>
          )}
        </div>
      )}
    </form>
  )
}

/** Step 2's answers: the business's current number forwards to the new one, or callers use the new one only. */
export type ForwardAnswer = 'forward' | 'none'

/** The number's mode for a step 2 answer: forwarding as the pick-up choice says, or a number of its own (`new`). */
export const modeForAnswer = (answer: ForwardAnswer, forwarding: 'forward_conditional' | 'forward_all') =>
  answer === 'forward' ? forwarding : ('new' as const)

/** The step 2 answer a number's mode stands for (a forwarding mode: forward; anything else: none). */
export const answerForMode = (mode: PhoneNumber['mode']): ForwardAnswer =>
  mode === 'forward_conditional' || mode === 'forward_all' ? 'forward' : 'none'

/**
 * Add number, step 2: "Forward your current number here?" Each answer is saved on the number at once (phoneNumber.update,
 * its mode); forwarding shows the same check and short codes as the number's Manage dialog.
 */
function ForwardStep({
  number,
  name,
  forwarding,
  onDone,
}: {
  number: PhoneNumber
  name: string
  /** The forwarding mode of the workspace's pick-up choice. */
  forwarding: 'forward_conditional' | 'forward_all'
  onDone: () => void
}) {
  const t = useT()
  const run = useRun()
  const pick = useForwardingPick(number)
  const answer = answerForMode(number.mode)
  const formatted = formatNumber(number.e164)
  const choose = (next: ForwardAnswer) => {
    if (next === answer) return
    void run('phoneNumber.update', { phoneNumberId: number.id, mode: modeForAnswer(next, forwarding) })
  }
  const mode = number.mode === 'forward_all' ? 'forward_all' : 'forward_conditional'
  return (
    <div className="st-connect pn-connect">
      <p className="pn-added" role="status">
        <StatusMark state="works" label={t('settings.phone.forwardStep.added', { number: formatted, name })} />
        {t('settings.phone.forwardStep.added', { number: formatted, name })}
      </p>
      <div className="st-pn-t">
        <b>{t('settings.phone.forwardStep.title')}</b>
      </div>
      <div className="k-radios st-pn-kinds" role="radiogroup" aria-label={t('settings.phone.forwardStep.title')}>
        <RadioCard
          name="st-pn-forward"
          checked={answer === 'forward'}
          onPick={() => choose('forward')}
          title={t('settings.phone.forwardStep.yes.title')}
          description={t('settings.phone.forwardStep.yes.description', { name })}
        />
        <RadioCard
          name="st-pn-forward"
          checked={answer === 'none'}
          onPick={() => choose('none')}
          title={t('settings.phone.forwardStep.no.title')}
          description={t('settings.phone.forwardStep.no.description', { name, number: formatted })}
        />
      </div>
      {answer === 'forward' && (
        <CheckWhenEditing number={number} canEdit onCarrier={pick.setGuide} pickedByOwner={pick.pickedByOwner}>
          <Field
            id="pn-codes"
            label={t('settings.phone.manage.forwarding')}
            tip={
              mode === 'forward_all'
                ? t('settings.phone.manage.forwardingAllTip')
                : t('settings.phone.manage.forwardingConditionalTip')
            }
          >
            <Forwarding pick={pick} e164={number.e164} mode={mode} />
          </Field>
        </CheckWhenEditing>
      )}
      <div className="st-connect-foot">
        <Button size="sm" variant="primary" onClick={onDone}>
          {t('settings.phone.manage.done')}
        </Button>
      </div>
    </div>
  )
}
