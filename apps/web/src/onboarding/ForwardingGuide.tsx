// The forwarding instructions for one line: a country picker, a carrier picker that searches that country's guides
// (and the apps for every country), then the one instruction for the chosen carrier (codes to type in the phone app,
// with Copy, a tap-to-dial link on Android and a QR code on laptops; or numbered settings steps for phone systems), how to turn it off and check it, and what
// typically goes wrong. Used by onboarding and Settings › Phone numbers.
import {
  abroadWarning,
  type ForwardingGuide,
  type ForwardingMode,
  findGuide,
  forwardingCountries,
  forwardingGuideById,
  forwardingInstructions,
  guideCountry,
  guideInCountry,
  guideKindLabels,
  guidesForCountry,
  hasForwardingCountry,
  OTHER_COUNTRY,
  otherCountryOption,
  phoneChecklist,
  preselectForwardingCountry,
  type ResolvedCode,
  searchForwardingGuides,
} from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useWorkspaceSettings } from '../settings/settings-api.ts'
import { useAssistants } from '../store.tsx'
import { useAnchoredList } from '../ui/floating.ts'
import { Icon, cx } from '../ui/kit.tsx'
import { encodeQr, qrPath } from '../ui/qr.ts'
import { useMediaQuery } from '../ui/useMediaQuery.ts'
import { CopyButton } from './Frame.tsx'
import { dialPath } from './flow.ts'
import { type GuidePickedBy, ownerPick } from './forwarding-check.ts'
import './forwarding-guide.css'

const guideKey = (numberId: string) => `linedesk.forwardingGuide.${numberId}`
const guideByKey = (numberId: string) => `linedesk.forwardingGuideBy.${numberId}`

/**
 * The guide picked for a number, remembered in this browser so Settings shows the carrier chosen in onboarding,
 * with who picked it (the owner in the picker, or a carrier lookup) and the guide the owner picked by hand, if any.
 * null until the owner picks one or a lookup finds it: no carrier is assumed. Storage can be missing or blocked: then
 * nothing is remembered.
 */
export function useForwardingGuide(
  numberId: string,
): [string | null, (guideId: string, by?: GuidePickedBy) => void, string | null] {
  const [state, setState] = useState<{ id: string | null; byOwner: string | null }>(() => {
    try {
      const saved = localStorage.getItem(guideKey(numberId))
      if (!saved || !forwardingGuideById(saved)) return { id: null, byOwner: null }
      return { id: saved, byOwner: ownerPick(saved, localStorage.getItem(guideByKey(numberId))) }
    } catch {
      return { id: null, byOwner: null }
    }
  })
  const pick = (id: string, by: GuidePickedBy = 'owner') => {
    setState({ id, byOwner: by === 'owner' ? id : null })
    try {
      localStorage.setItem(guideKey(numberId), id)
      if (by === 'lookup') localStorage.setItem(guideByKey(numberId), 'lookup')
      else localStorage.removeItem(guideByKey(numberId))
    } catch {
      // Not remembered; the pick still applies on this page.
    }
  }
  return [state.id, pick, state.byOwner]
}

const guideDescription = (g: ForwardingGuide, t: ReturnType<typeof useT>) =>
  g.network
    ? t('onboarding.forwarding.guideNetwork', { kind: guideKindLabels[g.kind], network: g.network })
    : guideKindLabels[g.kind]

const countryKey = (numberId: string) => `linedesk.forwardingCountry.${numberId}`

/**
 * The country whose carriers the guide lists for a number: the one picked for it in this browser, else the country of
 * the guide picked, else the most likely one (preselectForwardingCountry: the workspace's country as set, the
 * assistant number's country, the workspace's, the business number's, the browser's locale, the US). Worked out on every render, so it follows the
 * workspace settings once they load, until the owner picks one.
 */
function useForwardingCountry(numberId: string, e164: string, guideId: string | null): [string, (c: string) => void] {
  const [picked, setPicked] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem(countryKey(numberId))
      return saved && (saved === OTHER_COUNTRY || hasForwardingCountry(saved)) ? saved : null
    } catch {
      return null
    }
  })
  const settings = useWorkspaceSettings().data
  const businessNumber = (useAssistants()[0]?.business_profile as { phone?: string } | undefined)?.phone
  const guide = guideId ? findGuide(guideId) : undefined
  const country =
    picked ??
    (guide ? guideCountry(guide) : null) ??
    preselectForwardingCountry({
      country: settings?.country ?? null,
      assistantNumber: e164,
      workspaceCountry: settings?.holidays?.country ?? null,
      businessNumber,
      locale: typeof navigator === 'undefined' ? null : navigator.language,
    })
  const pick = (code: string) => {
    setPicked(code)
    try {
      localStorage.setItem(countryKey(numberId), code)
    } catch {
      // Not remembered; the pick still applies on this page.
    }
  }
  return [country, pick]
}

/**
 * The country and guide picked for a number. The guide shown is only one of the country's: after the owner switches
 * the country, the carrier picker is empty until they pick one there. A guide picked elsewhere (a carrier lookup
 * of the business number) brings its own country with it.
 */
export function useForwardingPick(number: { id: string; e164: string }) {
  const [guideId, setGuideId, pickedByOwner] = useForwardingGuide(number.id)
  const [country, setCountry] = useForwardingCountry(number.id, number.e164, guideId)
  const saved = guideId ? findGuide(guideId) : undefined
  const guide = saved && guideInCountry(saved, country) ? saved : undefined
  const setGuide = (id: string, by?: GuidePickedBy) => {
    const g = findGuide(id)
    const home = g && !guideInCountry(g, country) ? guideCountry(g) : null
    if (home) setCountry(home)
    setGuideId(id, by)
  }
  return { country, setCountry, guide, guideId: guide?.id ?? null, setGuide, pickedByOwner }
}

type PickerItem = { id: string; name: string; description?: string }

/**
 * A search field with a list: typing filters it, arrow keys move, Enter picks, Esc closes. The carrier picker and
 * the country picker.
 */
function SearchPicker({
  value,
  items,
  onChange,
  id,
  label,
  placeholder,
  listLabel,
  empty,
  className,
}: {
  /** null: none picked yet, the field shows empty. */
  value: string | null
  /** The items matching what was typed, best first; all of them for an empty search. */
  items: (query: string) => PickerItem[]
  onChange: (id: string) => void
  id: string
  /** The field's name when no visible <label htmlFor={id}> names it. */
  label?: string
  placeholder: string
  listLabel: string
  empty: string
  className?: string
}) {
  const current = value ? items('').find(i => i.id === value) : undefined
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const matches = useMemo(() => items(query), [items, query])
  useAnchoredList(open, root, list, { match: true })

  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  })
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, listId])

  function show() {
    setQuery('')
    setActive(
      Math.max(
        0,
        items('').findIndex(i => i.id === value),
      ),
    )
    setOpen(true)
  }
  function close() {
    setOpen(false)
    setQuery('')
  }
  function pick(item: PickerItem) {
    close()
    input.current?.blur()
    if (item.id !== value) onChange(item.id)
  }
  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) return show()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive(i => Math.min(matches.length - 1, Math.max(0, i + step)))
    } else if (e.key === 'Enter' && open) {
      // The step's own Enter (continue) must not fire while picking.
      e.preventDefault()
      e.stopPropagation()
      const item = matches[active]
      if (item) pick(item)
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  return (
    <div className={cx('k-select fg-picker', className)} ref={root}>
      <span className="k-input fg-search">
        <Icon name="search" size={14} />
        <input
          ref={input}
          id={id}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={open ? query : (current?.name ?? '')}
          // Focus alone (a dialog focuses its first field) doesn't open the list; typing replaces the shown name.
          onFocus={e => e.target.select()}
          onClick={() => !open && show()}
          onChange={e => {
            // Typing while the list is closed starts a new search, not one after the shown name.
            const typed = e.target.value
            const name = current?.name ?? ''
            setQuery(!open && name && typed.startsWith(name) ? typed.slice(name.length) : typed)
            setActive(0)
            setOpen(true)
          }}
          onKeyDown={onKey}
          onBlur={() => open && close()}
        />
        <Icon name="down" size={14} />
      </span>
      {open && (
        <div
          ref={list}
          id={listId}
          popover="manual"
          className="k-select-list fg-list k-float"
          role="listbox"
          aria-label={listLabel}
        >
          {matches.length === 0 && <div className="fg-empty">{empty}</div>}
          {matches.map((item, i) => (
            <div
              key={item.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={item.id === value}
              className={cx('k-select-opt', i === active && 'active')}
              onMouseEnter={() => setActive(i)}
              onMouseDown={e => e.preventDefault()}
              onClick={() => pick(item)}
            >
              <span className="k-select-opt-t">
                <span>{item.name}</span>
                {item.description && <small>{item.description}</small>}
              </span>
              {item.id === value && <Icon name="check" size={14} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The carriers and phone systems of `country`. Typing filters by name, former name or network ("openphone",
 * "metro", "verizon network").
 */
export function CarrierPicker({
  value,
  onChange,
  id,
  label,
  country,
}: {
  value: string | null
  onChange: (guideId: string) => void
  id: string
  label?: string
  country: string
}) {
  const t = useT()
  const items = useCallback(
    (query: string) =>
      searchForwardingGuides(query, country).map(g => ({
        id: g.id,
        name: g.name,
        description: guideDescription(g, t),
      })),
    [country, t],
  )
  const fallback = guidesForCountry(country).find(g => g.kind === 'mobile' && /other-mobile$/.test(g.id))
  return (
    <SearchPicker
      id={id}
      label={label}
      value={value}
      onChange={onChange}
      items={items}
      placeholder={t('onboarding.forwarding.carrierSearch')}
      listLabel={t('onboarding.forwarding.carrierList')}
      empty={t('onboarding.forwarding.carrierEmpty', {
        fallback: fallback?.name ?? t('onboarding.forwarding.carrierFallback'),
      })}
    />
  )
}

const countryOptions = (otherDescription: string): readonly PickerItem[] => [
  ...forwardingCountries.map(c => ({ id: c.code, name: c.name })),
  { id: otherCountryOption.code, name: otherCountryOption.name, description: otherDescription },
]
const countryWords = (name: string) => ` ${name.toLowerCase()}`

/** Countries with guides, then "Other country". Typing filters by name or code ("ger", "de"). */
function searchCountries(options: readonly PickerItem[], typed: string): PickerItem[] {
  const query = typed.trim().toLowerCase()
  if (!query) return [...options]
  return options.filter(
    c => countryWords(c.name).includes(` ${query}`) || c.id.toLowerCase() === query || c.id === OTHER_COUNTRY,
  )
}

/** The country first, then its carriers and phone systems, side by side. */
export function GuidePickers({
  id,
  label,
  country,
  onCountry,
  guideId,
  onGuide,
}: {
  id: string
  label?: string
  country: string
  onCountry: (country: string) => void
  guideId: string | null
  onGuide: (guideId: string) => void
}) {
  const t = useT()
  const otherDescription = t('onboarding.forwarding.otherCountryDescription')
  const countries = useCallback(
    (typed: string) => searchCountries(countryOptions(otherDescription), typed),
    [otherDescription],
  )
  return (
    <div className="fg-pickers">
      <SearchPicker
        id={`${id}-country`}
        label={t('onboarding.forwarding.country')}
        className="fg-country"
        value={country}
        onChange={onCountry}
        items={countries}
        placeholder={t('onboarding.forwarding.country')}
        listLabel={t('common.phone.countries')}
        empty={t('onboarding.forwarding.countryEmpty', { other: otherCountryOption.name })}
      />
      <CarrierPicker id={id} label={label} value={guideId} onChange={onGuide} country={country} />
    </div>
  )
}

/**
 * One line when the assistant's number is in another country than the business line: forwarding then goes abroad
 * (it can cost extra), or, with a carrier that forwards only within its country, won't work at all. Nothing otherwise.
 */
export function AbroadWarning({
  e164,
  country,
  guide,
}: {
  e164: string
  country: string
  guide?: ForwardingGuide | null
}) {
  const warning = abroadWarning(e164, country, guide)
  if (!warning) return null
  return (
    <p
      className={cx('fg-abroad', warning.kind === 'blocked' && 'blocked')}
      role={warning.kind === 'blocked' ? 'alert' : 'status'}
    >
      {warning.text}
    </p>
  )
}

/** A QR code as an inline SVG; scanning it opens `text` (a tel: link) on the phone. */
export function QrCode({ text, size = 148, label }: { text: string; size?: number; label: string }) {
  const qr = useMemo(() => encodeQr(text), [text])
  const units = qr.size + 8
  return (
    <svg className="fg-qr" width={size} height={size} viewBox={`0 0 ${units} ${units}`} role="img" aria-label={label}>
      <rect width={units} height={units} fill="#fff" />
      <path d={qrPath(qr)} fill="#000" shapeRendering="crispEdges" />
    </svg>
  )
}

const codesText = (codes: readonly ResolvedCode[]) => codes.map(c => c.code).join(', ')

/**
 * The instruction for `guide` to forward to `e164` in `mode`. `compact` (Settings) leaves out the phone checklist
 * and shows the extras folded.
 */
export function ForwardingSteps({
  guide,
  mode,
  e164,
  country,
  compact,
}: {
  guide: ForwardingGuide
  mode: ForwardingMode
  e164: string
  /** The country picked, which decides how the number is written in the codes. */
  country?: string
  compact?: boolean
}) {
  const t = useT()
  const steps = forwardingInstructions(guide, mode, e164, country)
  // The way that works on every phone is typing the code in the Phone app: an iPhone blocks links that turn on call
  // forwarding (Apple's call forwarding guide), so a tel: link (Dial, the QR code) is only an extra for Android. A
  // laptop shows a QR code that opens the dialer on an Android phone.
  const coarse = useMediaQuery('(pointer: coarse)')
  const path = dialPath(navigator.userAgent, navigator.maxTouchPoints ?? 0, coarse)
  const touch = path !== 'qr'
  // Which code the QR code dials; back to the first for another carrier or mode.
  const qrKey = `${guide.id}:${mode}`
  const [qr, setQr] = useState({ key: qrKey, index: 0 })
  const qrIndex = qr.key === qrKey ? qr.index : 0
  const setQrIndex = (index: number) => setQr({ key: qrKey, index })

  if (!steps)
    return (
      <div className="fg-card">
        <p className="fg-none">{guide.note ?? t('onboarding.forwarding.noSteps', { carrier: guide.name })}</p>
        <Sources guide={guide} />
      </div>
    )

  const mobile = guide.kind === 'mobile'
  const qrCode = steps.how === 'dial' ? (steps.on[qrIndex] ?? steps.on[0]) : undefined
  return (
    <div className="fg-card">
      {steps.how === 'dial' ? (
        <>
          <p className="fg-lead">
            {mobile
              ? t('onboarding.forwarding.leadMobile', { count: steps.on.length })
              : t('onboarding.forwarding.leadDesk', { count: steps.on.length })}
          </p>
          <div className={cx('fg-dial', mobile && !touch && 'with-qr')}>
            <ol className="fg-codes">
              {steps.on.map((c, i) => (
                <li key={c.code} className={cx(mobile && !touch && i === qrIndex && steps.on.length > 1 && 'on')}>
                  <span className="fg-code">
                    <b>{c.code}</b>
                    {c.when && <span className="help">{c.when}</span>}
                  </span>
                  <span className="fg-acts">
                    <CopyButton text={c.code} label={t('common.copy.copy')} />
                    {mobile && path === 'dial' && (
                      <a
                        className="k-btn k-btn-ghost k-btn-sm"
                        href={c.href}
                        title={t('onboarding.forwarding.dialTitle')}
                      >
                        <Icon name="phone" size={14} />
                        <span>{t('onboarding.forwarding.dial')}</span>
                      </a>
                    )}
                    {mobile && !touch && steps.on.length > 1 && (
                      <button
                        type="button"
                        className="k-btn k-btn-ghost k-btn-sm"
                        aria-pressed={i === qrIndex}
                        title={t('onboarding.forwarding.showQrTitle')}
                        onClick={() => setQrIndex(i)}
                      >
                        <span>{t('onboarding.forwarding.showQr')}</span>
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ol>
            {mobile && !touch && qrCode && (
              <figure className="fg-qr-box">
                <QrCode text={qrCode.href} label={t('onboarding.forwarding.qrLabel', { code: qrCode.code })} />
                <figcaption>{t('onboarding.forwarding.qrCaption', { code: qrCode.code })}</figcaption>
              </figure>
            )}
          </div>
          <p className="fg-meta">
            <T
              k={
                steps.off.length > 0
                  ? steps.check.length > 0
                    ? 'onboarding.forwarding.offCodesCheck'
                    : 'onboarding.forwarding.offCodes'
                  : steps.check.length > 0
                    ? 'onboarding.forwarding.offAskCheck'
                    : 'onboarding.forwarding.offAsk'
              }
              values={{
                off: codesText(steps.off),
                check: codesText(steps.check),
                carrier: guide.name,
                code: chunks => <code>{chunks}</code>,
              }}
            />
          </p>
        </>
      ) : (
        <>
          <p className="fg-lead">{t('onboarding.forwarding.leadSettings', { where: steps.where })}</p>
          <ol className="fg-steps">
            {steps.on.map(s => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="fg-meta">
            {steps.check
              ? t('onboarding.forwarding.settingsOffCheck', { steps: steps.off.join(' '), where: steps.check })
              : t('onboarding.forwarding.settingsOff', { steps: steps.off.join(' ') })}
          </p>
        </>
      )}
      {guide.note && <p className="fg-meta">{guide.note}</p>}
      {(guide.pitfalls.length > 0 || (mobile && !compact)) && (
        <details className="fg-more" open={!compact}>
          <summary>{t('onboarding.forwarding.goodToKnow')}</summary>
          <ul>
            {guide.pitfalls.map(p => (
              <li key={p}>{p}</li>
            ))}
            {mobile && !compact && (
              <li>{t('onboarding.forwarding.checklist', { checklist: phoneChecklist.join(' ') })}</li>
            )}
          </ul>
        </details>
      )}
      <Sources guide={guide} />
    </div>
  )
}

function Sources({ guide }: { guide: ForwardingGuide }) {
  const links = (
    <>
      {guide.sources.map((s, i) => (
        <span key={s.url}>
          {i > 0 && ', '}
          <a href={s.url} target="_blank" rel="noreferrer">
            {s.label}
          </a>
        </span>
      ))}
    </>
  )
  return (
    <p className="fg-src">
      <T k="onboarding.forwarding.source" values={{ links }} />
    </p>
  )
}
