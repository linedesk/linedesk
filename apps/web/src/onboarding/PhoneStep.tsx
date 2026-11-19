// The phone step: connect a number the assistant answers, then (for a number the business keeps) the forwarding code.
// It leads with keeping the business's number: a new number to give out reaches the assistant only when dialled.
import type { PhoneNumber } from '@linedesk/db/types'
import { T, useT } from '@linedesk/i18n/react'
import { appLink } from '../ui/AppLink.tsx'
import { useEffect, useRef, useState } from 'react'
import type { PhoneSetupStatus } from '../auth.ts'
import { useDefaultPhoneCountry } from '../phoneCountry.ts'
import { AreaCodeInput } from '../settings/AreaCodeInput.tsx'
import { CarrierNumberInput } from '../settings/CarrierNumberInput.tsx'
import { Field } from '../settings/fields.tsx'
import { NearbyAreaCodes } from '../settings/NearbyAreaCodes.tsx'
import { useWorkspaceSettings, useWriteAction } from '../settings/settings-api.ts'
import { useAssistant, useAssistantName, useRows, useRun } from '../store.tsx'
import { useWorkspaceCountry } from '../workspaceLocale.ts'
import { NumberRequestFlow } from '../numbers/NumberRequestFlow.tsx'
import { useKycCountry } from '../numbers/numberRequestQueries.ts'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { RadioCard } from '../ui/controls.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { ForwardingCheck } from './ForwardingCheck.tsx'
import { AbroadWarning, ForwardingSteps, GuidePickers, useForwardingPick } from './ForwardingGuide.tsx'
import { Foot, useStepKeys } from './Frame.tsx'
import {
  areaCodeIn,
  areaCodeOf,
  buyQuestion,
  buyingCountry,
  buyUnavailableText,
  carrierName,
  existingLinkText,
  firstPickup,
  formatNumber,
  forwardingOffer,
  isNoneFreeText,
  type PhoneOption,
  phoneOptionSetup,
  offersBuying,
  phoneOptions,
  phoneOptionText,
  pickupNumberMode,
  priceCountry,
  priceNote,
  turnOffFirst,
  URGENT_CONTACT_ID,
} from './flow.ts'
import { useClientWord } from './clientWords.tsx'

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
  /** The business's name: prefills a number request's details (a country that checks documents). */
  businessName?: string
  onBack: () => void
  onNext: () => void
}

/** How long the purchase question shows before Enter buys (a held or double-pressed Enter only asks). */
const CONFIRM_ENTER_MS = 800

/** A number is never skipped, only connected later: it stays in the go-live checklist. */
function useLater() {
  const t = useT()
  return { laterLabel: t('onboarding.phone.later'), laterTitle: t('onboarding.phone.laterTitle') }
}

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
  return (
    <ChooseOrRequest {...p} firstAreaCode={areaCodeOf(null, businessPhone, mobile)} businessPhone={businessPhone} />
  )
}

/**
 * In a country whose carrier checks documents first (Germany, when the server takes requests there), the number is
 * requested (NumberRequestFlow); elsewhere it is bought or connected at once (Choose). A number already in the
 * carrier account (instance admins) can still be connected from the request's first step.
 */
function ChooseOrRequest(p: Props & { firstAreaCode: string; businessPhone: string | null }) {
  const t = useT()
  const kyc = useKycCountry()
  const [existing, setExisting] = useState(false)
  if (kyc.loading)
    return (
      <>
        <div className="ob-body">
          <Loading what={t('onboarding.numberRequest.loading')} loading skeleton={<SkeletonFields fields={3} />} />
        </div>
        <Foot onBack={p.onBack} onSkipStep={p.onNext} canContinue={false} />
      </>
    )
  if (kyc.country && !existing)
    return (
      <NumberRequestFlow
        country={kyc.country}
        known={{ businessName: p.businessName ?? '', phone: p.businessPhone ?? '' }}
        onExisting={p.status.canAttach !== false ? () => setExisting(true) : undefined}
        onBack={p.onBack}
        onNext={p.onNext}
      />
    )
  return <Choose {...p} />
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
  const t = useT()
  const later = useLater()
  // Nothing to connect: Enter does nothing (no primary), Esc goes back.
  useStepKeys({ onEscape: onBack })
  return (
    <>
      <div className="ob-body">
        <h1>{t('onboarding.phone.unavailable.title')}</h1>
        <p className="ob-lede">
          {/* The same as Settings › Phone numbers: admins get the place to fix it, everyone else whom to ask. */}
          {admin ? (
            <T
              k="onboarding.phone.unavailable.ledeAdmin"
              values={{
                link: appLink('#admin/providers/telephony', { title: detail ?? undefined }),
              }}
            />
          ) : (
            t('onboarding.phone.unavailable.lede')
          )}
        </p>
      </div>
      <Foot onBack={onBack} onContinue={onNext} canContinue={false} onSkipStep={onNext} {...later} />
    </>
  )
}

function Choose({ status, setupError, clearError, onBack, onNext, firstAreaCode }: Props & { firstAreaCode: string }) {
  const t = useT()
  const word = useClientWord()
  const later = useLater()
  const run = useRun()
  const name = useAssistantName()
  // Numbers already in the install's carrier account are for instance admins only: only they see the link to it.
  const canAttach = status?.canAttach !== false
  // Outside the countries numbers can be bought in, only a number the business already has (offersBuying).
  // Unknown yet: every buyable area code, and the one picked names the country (buyingCountry).
  const country = buyingCountry(useWorkspaceCountry())
  const buyable = offersBuying(country)
  const [chosen, setOption] = useState<PhoneOption>(phoneOptions[0]!)
  const option: PhoneOption = buyable ? chosen : 'existing'
  // Nothing to connect here: no buying, and the install's carrier account is for instance admins only.
  const nothingToConnect = !buyable && !canAttach
  // E.164 as far as typed (PhoneInput). No number is connected yet, so no forwarding guide has picked a country.
  const [typed, setTyped] = useState('')
  const phoneCountry = useDefaultPhoneCountry()
  // Prefilled from a number the owner already gave; empty otherwise (no example that looks filled in).
  const [picked, setAreaCode] = useState(firstAreaCode)
  // Only a code of the workspace's country (its list): a prefilled one of another country is dropped.
  const areaCode = areaCodeIn(picked, country) ? picked : ''
  const [confirming, setConfirming] = useState(false)
  // When the purchase question appeared: Enter buys only once it has been on screen a moment, never a repeated key.
  const askedAt = useRef(0)
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
    if (sending || nothingToConnect) return
    if (!buying) return send(false)
    // Buying is a second, deliberate step: the first press asks the question above the footer, whose primary button
    // then buys (a click, or Enter once the question has been read for a moment).
    if (!confirming) {
      const check = phoneOptionSetup(option, { number: typed, areaCode, confirmed: true }, forwarding)
      if ('problem' in check) return setProblem(check.problem)
      setProblem(null)
      ask()
      return
    }
    send(true)
  }
  function ask() {
    askedAt.current = Date.now()
    setConfirming(true)
  }
  const enterBuys = () => Date.now() - askedAt.current >= CONFIRM_ENTER_MS
  function pick(next: PhoneOption) {
    setOption(next)
    setConfirming(false)
    setProblem(null)
  }
  const toChoices = () => pick(phoneOptions[0]!)
  useStepKeys({
    onEnter: () => (confirming && !enterBuys() ? undefined : primary()),
    onEscape: () => (confirming ? setConfirming(false) : option === 'existing' && buyable ? toChoices() : onBack()),
  })

  const error = problem ?? setupError
  const existing = phoneOptionText('existing', name, carrier, word)
  return (
    <>
      <div className="ob-body">
        <h1>
          {forwarding === 'forward_all'
            ? t(word('onboarding.phone.choose.titleAll'))
            : t(word('onboarding.phone.choose.titleMissed'))}
        </h1>
        <p className="ob-lede">
          {forwarding === 'forward_all'
            ? t('onboarding.phone.choose.ledeAll', { name })
            : t(word('onboarding.phone.choose.ledeMissed'), { name })}
        </p>
        {option === 'existing' ? (
          <div className="ob-existing">
            <b>{existing.title}</b>
            <span className="ob2-note">{buyable ? existing.description : buyUnavailableText(carrier, canAttach)}</span>
          </div>
        ) : (
          <>
            <div className="k-radios ob-choices" role="radiogroup" aria-label={t('onboarding.phone.choose.label')}>
              {phoneOptions.map(o => (
                <RadioCard
                  key={o}
                  name="ob-mode"
                  checked={option === o}
                  onPick={() => pick(o)}
                  {...phoneOptionText(o, name, carrier, word)}
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
        {dev && option === 'existing' && <p className="ob2-note">{t('onboarding.phone.choose.dev')}</p>}
        {nothingToConnect ? null : option === 'existing' ? (
          <>
            <Field
              id="ob-number"
              label={carrier ? t('onboarding.phone.choose.numberIn', { carrier }) : t('onboarding.phone.choose.number')}
            >
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
            {buyable && (
              <button
                type="button"
                className="ob-link"
                onClick={toChoices}
                title={t('onboarding.phone.choose.backToChoicesTip', { key: 'Esc' })}
              >
                {t('onboarding.phone.choose.backToChoices')}
              </button>
            )}
          </>
        ) : (
          <>
            <Field
              id="ob-area"
              label={
                option === 'forward'
                  ? t('onboarding.phone.choose.areaCodeFor', { name })
                  : t('onboarding.phone.choose.areaCode')
              }
            >
              <AreaCodeInput
                id="ob-area"
                country={country}
                value={areaCode}
                onChange={v => {
                  setAreaCode(v)
                  setConfirming(false)
                  setProblem(null)
                  clearError()
                }}
              />
            </Field>
            <p className="ob2-note">{priceNote(status.provider, priceCountry(areaCode, country))}</p>
            {/* The question right above the footer, whose primary button does it; Back (Esc) cancels. */}
            {confirming && (
              <p className="ob-confirm" role="alert">
                {buyQuestion(status.provider, areaCode)}
              </p>
            )}
          </>
        )}
        {error && buying && areaCode && isNoneFreeText(error) ? (
          <NearbyAreaCodes
            areaCode={areaCode}
            message={error}
            onPick={code => {
              setAreaCode(code)
              setProblem(null)
              clearError()
              // The next step is the purchase question for that code, as after the primary button.
              ask()
            }}
          />
        ) : (
          error && <Note tone="danger">{error}</Note>
        )}
      </div>
      <Foot
        onBack={confirming && !sending ? () => setConfirming(false) : onBack}
        onContinue={primary}
        onSkipStep={confirming ? undefined : onNext}
        {...later}
        canContinue={!nothingToConnect}
        busy={sending}
        // Nothing to connect here: the primary stays off, only "Connect later" goes on.
        label={
          confirming
            ? dev
              ? t('onboarding.phone.choose.addTestNumber')
              : t('onboarding.phone.choose.buyNumber')
            : buying
              ? dev
                ? t('onboarding.phone.choose.addATestNumber')
                : t('onboarding.phone.choose.getNumber')
              : t('onboarding.phone.choose.connectNumber')
        }
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
  const t = useT()
  const word = useClientWord()
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
      setForwardProblem(t('onboarding.phone.connected.forwardFailed')),
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
        <h1>
          {all
            ? t(word('onboarding.phone.connected.titleAll'))
            : forwards
              ? t(word('onboarding.phone.connected.titleMissed'))
              : t(word('onboarding.phone.connected.titleReady'))}
        </h1>
        <Note tone="success">
          {t('onboarding.phone.connected.answers', { name, number: formatNumber(number.e164) })}
        </Note>
        {offer && (
          <>
            <p className="ob-lede">
              {t(word('onboarding.phone.connected.onlyNew'), { name, number: formatNumber(number.e164) })}
            </p>
            <div className="ob2-row">
              <Button variant="secondary" onClick={forwardToo}>
                {offer === 'forward_all'
                  ? t(word('onboarding.phone.connected.forwardAllToo'))
                  : t(word('onboarding.phone.connected.forwardMissedToo'))}
              </Button>
            </div>
            {forwardProblem && <Note tone="danger">{forwardProblem}</Note>}
          </>
        )}
        {forwards && (
          <>
            <p className="ob-lede">
              {all
                ? t(word('onboarding.phone.connected.keepAll'), { name })
                : t(word('onboarding.phone.connected.keepMissed'), { name })}
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
                  {t(word('onboarding.phone.connected.carrier'))}
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
                <p className="ob2-note">{t(word('onboarding.phone.connected.pickCarrier'))}</p>
              )}
            </ForwardingCheck>
          </>
        )}
      </div>
      <Foot onBack={onBack} onContinue={onNext} canContinue />
    </>
  )
}
