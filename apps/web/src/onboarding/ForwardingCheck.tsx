// The forwarding check (onboarding concept, 6a and 6c), in the order the owner goes: the business's own number first,
// its carrier from a lookup, then the carrier and codes (`children`), then "Check forwarding": Linedesk calls that
// number and watches whether the call reaches the assistant. Used in the phone step and in Settings › Phone numbers.
import { type ForwardingCheckView, forwardingGuideById, type LineLookupData } from '@linedesk/actions'
import type { PhoneNumber } from '@linedesk/db/types'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { callAction, readAction, useWriteAction } from '../settings/settings-api.ts'
import { Field } from '../settings/fields.tsx'
import { rejectionText } from '../shell/rejections.ts'
import { useAssistantName, useRun } from '../store.tsx'
import { Input } from '../ui/form.tsx'
import { Button, cx, Icon } from '../ui/kit.tsx'
import {
  checkResultText,
  type GuidePickedBy,
  lineText,
  lookupGuide,
  noCheckText,
  SIMULATED_MARK,
} from './forwarding-check.ts'
import { formatNumber, toE164 } from './flow.ts'

const POLL_MS = 2000
/** Reads that fail in a row before the check says so and offers to try again; until then it backs off. */
const POLL_FAILURES = 3
const POLL_MAX_MS = 15_000

/** Lookups already answered in this tab, by number: opening the dialog again does not ask the carrier again. */
const lookedUp = new Map<string, LineLookupData>()

type Props = {
  number: PhoneNumber
  /** The business phone the owner gave earlier (the first step): prefills the number field when nothing else is known. */
  businessNumber?: string
  /** The carrier picker and the codes: shown after the number and its lookup, before "Check forwarding". */
  children?: ReactNode
  /**
   * The carrier lookup found a carrier with a forwarding guide: preselect it (by: lookup) while the owner has not
   * picked one by hand, else offer it; the owner taking the offer is their pick (by: owner).
   */
  onCarrier?: (guideId: string, by: GuidePickedBy) => void
  /** The guide the owner picked by hand for this number, or null. A lookup never replaces it. */
  pickedByOwner?: string | null
  /** Look up the saved business number on opening too (the phone step), not only a number the owner types. */
  lookupOnOpen?: boolean
  /** Owners and admins only (settings:write); others see the last result. */
  canCheck?: boolean
}

export function ForwardingCheck({
  number,
  businessNumber: given,
  children,
  onCarrier,
  pickedByOwner = null,
  lookupOnOpen = false,
  canCheck = true,
}: Props) {
  const name = useAssistantName()
  const write = useWriteAction()
  const run = useRun()
  const [typed, setTyped] = useState(() => {
    const known = number.forwarded_from ?? (given && toE164(given))
    return known ? formatNumber(known) : ''
  })
  const [edited, setEdited] = useState(false)
  const [check, setCheck] = useState<ForwardingCheckView | null>(null)
  // Whether this server can run a check (null until known): when it cannot, no button, only how to test by hand.
  const [available, setAvailable] = useState<boolean | null>(null)
  const [line, setLine] = useState<{ text: string; simulated: boolean } | null>(null)
  const [found, setFound] = useState<string | null>(null)
  // A lookup that failed: one quiet line, and no carrier picked from it.
  const [lookupNote, setLookupNote] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  // Reading the check failed several times in a row: say so, with "Check again" (bumps `reread`).
  const [lost, setLost] = useState(false)
  const [reread, setReread] = useState(0)
  const looked = useRef<string | null>(null)
  const editedRef = useRef(edited)
  editedRef.current = edited
  const businessNumber = toE164(typed)
  const dialing = check?.status === 'dialing'

  // The business phone from the first step can arrive after this opens: it fills the field while that is empty.
  useEffect(() => {
    const e164 = given && toE164(given)
    if (e164) setTyped(current => current || formatNumber(e164))
  }, [given])

  // The last check of this number, then again every few seconds while one runs. A failed read is tried again, later
  // each time; after a few in a row the owner sees it, with "Check again".
  // biome-ignore lint/correctness/useExhaustiveDependencies: `reread` only starts the reading again
  useEffect(() => {
    let stop = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      const data = await readAction<{ check: ForwardingCheckView | null; available: boolean }>(
        'phoneNumber.forwardingCheck',
        { phoneNumberId: number.id },
      ).catch(() => null)
      if (stop) return
      if (!data) {
        failures += 1
        if (failures >= POLL_FAILURES) return setLost(true)
        timer = setTimeout(load, Math.min(POLL_MS * 2 ** failures, POLL_MAX_MS))
        return
      }
      failures = 0
      setLost(false)
      setCheck(data.check)
      setAvailable(data.available)
      // Nothing saved yet (it is saved once a check works): show the number checked last, unless the owner typed one.
      if (data.check && !number.forwarded_from && !editedRef.current) setTyped(formatNumber(data.check.businessNumber))
      if (data.check?.status === 'dialing') timer = setTimeout(load, POLL_MS)
    }
    // Once at first, and again when a check starts or ends; every few seconds while one runs.
    if (canCheck) timer = setTimeout(load, dialing ? POLL_MS : 0)
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [number.id, dialing, canCheck, reread])

  // The number's use changed (one of the fixes below, or the field above): the last result was about the old one.
  const mode = useRef(number.mode)
  useEffect(() => {
    if (mode.current === number.mode) return
    mode.current = number.mode
    setCheck(current => (current?.status === 'dialing' ? current : null))
  }, [number.mode])

  // Know the line (6a): carrier and line type of the business number, once per number; a known carrier picks its
  // guide. The phone step also looks up the saved number; elsewhere only a number the owner typed, not on every opening.
  async function lookUp(e164: string) {
    if (!canCheck || looked.current === e164) return
    looked.current = e164
    setLookupNote(null)
    let found = lookedUp.get(e164)
    if (!found) {
      try {
        found = await callAction<LineLookupData>('phoneNumber.lookupLine', { number: e164 })
      } catch (e) {
        if (looked.current !== e164) return
        // Nothing from a failed lookup: no line, no carrier picked. The owner picks it from the list.
        setLine(null)
        setFound(null)
        setLookupNote(rejectionText('phoneNumber.lookupLine', e instanceof Error ? e.message : String(e)))
        return
      }
    }
    if (looked.current !== e164) return
    lookedUp.set(e164, found)
    const text = lineText(found)
    setLine(text ? { text, simulated: found.simulated } : null)
    setFound(found.carrierId)
    const guide = lookupGuide(found.carrierId, pickedByOwner)
    if (guide && 'preselect' in guide) onCarrier?.(guide.preselect, 'lookup')
  }
  const wantsLookup = edited || Boolean(lookupOnOpen)
  // biome-ignore lint/correctness/useExhaustiveDependencies: looks up each complete number once, after typing stops
  useEffect(() => {
    if (!businessNumber || !wantsLookup) return
    const timer = setTimeout(() => void lookUp(businessNumber), 600)
    return () => clearTimeout(timer)
  }, [businessNumber, wantsLookup])

  async function start() {
    if (starting || dialing || !available) return
    if (!businessNumber) return setProblem('Enter your business number, the one your callers dial.')
    setProblem(null)
    setStarting(true)
    try {
      setCheck(
        await write<ForwardingCheckView>('phoneNumber.checkForwarding', { phoneNumberId: number.id, businessNumber }),
      )
    } catch (e) {
      setProblem(rejectionText('phoneNumber.checkForwarding', e instanceof Error ? e.message : String(e)))
    } finally {
      setStarting(false)
    }
  }

  /** A fix offered with a failed check: forward every call, or give out the assistant's own number. */
  function switchTo(mode: 'forward_all' | 'new') {
    void run('phoneNumber.update', { phoneNumberId: number.id, mode })
  }

  const result = check && checkResultText(check, name, number.mode === 'forward_all')
  // The lookup disagrees with the carrier the owner picked: say so, and leave the pick to them.
  const suggest = onCarrier ? lookupGuide(found, pickedByOwner) : null
  const suggested = suggest && 'suggest' in suggest ? forwardingGuideById(suggest.suggest) : undefined
  const fieldId = `fc-number-${number.id}`
  return (
    <div className="fc">
      {canCheck && (
        <Field
          id={fieldId}
          label="Your business number"
          tip="The number your callers dial today. We look up its carrier for the right codes."
        >
          <Input
            id={fieldId}
            value={typed}
            placeholder="The number, with area code"
            onChange={e => {
              setTyped(e.target.value)
              setEdited(true)
              setProblem(null)
            }}
            onKeyDown={e => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
              // Enter here looks the number up at once; it does not also go on to the next step.
              e.preventDefault()
              if (businessNumber) void lookUp(businessNumber)
            }}
          />
        </Field>
      )}
      {line && (
        <p className="ob2-note">
          {line.text}
          {line.simulated && <span className="fc-sim">{SIMULATED_MARK}</span>}
        </p>
      )}
      {lookupNote && <p className="ob2-note">{lookupNote}</p>}
      {suggested && (
        <p className="ob2-note fc-suggest">
          Your carrier looks like {suggested.name}.{' '}
          <button type="button" className="fc-switch" onClick={() => onCarrier?.(suggested.id, 'owner')}>
            Switch guide
          </button>
        </p>
      )}
      {children}
      {canCheck && available === false && !dialing && <p className="ob2-note">{noCheckText(name)}</p>}
      {canCheck && available && (
        <div className="ob2-row">
          <Button
            busy={starting || dialing}
            variant="secondary"
            onClick={() => void start()}
            disabled={starting || dialing}
            title="Call your business number and watch for the forwarded call"
          >
            {starting || dialing ? 'Checking…' : 'Check forwarding'}
          </Button>
        </div>
      )}
      {problem && (
        <p className="ob-error" role="alert">
          {problem}
        </p>
      )}
      {lost && (
        <p className="ob-error fc-lost" role="alert">
          {dialing ? 'The check’s result could not be read.' : 'The last check could not be loaded.'} Check your
          connection.{' '}
          <button
            type="button"
            className="fc-switch"
            onClick={() => {
              setLost(false)
              setReread(n => n + 1)
            }}
          >
            Check again
          </button>
        </p>
      )}
      {result && (
        <div className={cx('fc-result', result.ok && 'ok')} role="status" aria-live="polite">
          {result.ok && <Icon name="check" size={16} />}
          <span>
            <b>{result.title}</b>
            {result.next && <span className="fc-next">{result.next}</span>}
            {check.simulated && <span className="fc-sim">{SIMULATED_MARK}</span>}
            {result.fixes && canCheck && (
              <span className="ob2-row fc-fixes">
                {result.fixes.includes('forward_all') && (
                  <Button size="sm" variant="secondary" onClick={() => switchTo('forward_all')}>
                    Forward every call instead
                  </Button>
                )}
                {result.fixes.includes('new') && (
                  <Button size="sm" variant="ghost" onClick={() => switchTo('new')}>
                    Give out {formatNumber(number.e164)} instead
                  </Button>
                )}
              </span>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
