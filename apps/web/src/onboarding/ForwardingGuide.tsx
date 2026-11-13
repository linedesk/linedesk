// The forwarding instructions for one line: a carrier picker that searches every guide, then the one instruction for
// the chosen carrier (codes with tap-to-dial on phones and a QR code on laptops, or numbered settings steps for phone
// systems), how to turn it off and check it, and what typically goes wrong. Used by onboarding and Settings › Phone numbers.
import {
  type ForwardingGuide,
  type ForwardingMode,
  type ResolvedCode,
  forwardingGuideById,
  forwardingInstructions,
  guideKindLabels,
  phoneChecklist,
  searchForwardingGuides,
} from '@linedesk/actions'
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react'
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

const guideDescription = (g: ForwardingGuide) =>
  g.network ? `${guideKindLabels[g.kind]} · ${g.network} network` : guideKindLabels[g.kind]

/**
 * A search field with a list of carriers and phone systems. Typing filters by name, former name or network
 * ("openphone", "metro", "verizon network"); arrow keys move, Enter picks, Esc closes.
 */
export function CarrierPicker({
  value,
  onChange,
  id,
  label,
}: {
  /** null: none picked yet, the field shows empty. */
  value: string | null
  onChange: (guideId: string) => void
  id: string
  /** The field's name when no visible <label htmlFor={id}> names it. */
  label?: string
}) {
  const current = value ? forwardingGuideById(value) : undefined
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  const matches = useMemo(() => searchForwardingGuides(query), [query])

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
        searchForwardingGuides('').findIndex(g => g.id === value),
      ),
    )
    setOpen(true)
  }
  function close() {
    setOpen(false)
    setQuery('')
  }
  function pick(guide: ForwardingGuide) {
    close()
    input.current?.blur()
    if (guide.id !== value) onChange(guide.id)
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
      const guide = matches[active]
      if (guide) pick(guide)
    } else if (e.key === 'Escape' && open) {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  return (
    <div className="k-select fg-picker" ref={root}>
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
          placeholder="Search carriers and phone systems"
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
        <div id={listId} className="k-select-list fg-list" role="listbox" aria-label="Carriers and phone systems">
          {matches.length === 0 && (
            <div className="fg-empty">No match. Pick “Another cell carrier”, or search for your phone app.</div>
          )}
          {matches.map((g, i) => (
            <div
              key={g.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={g.id === value}
              className={cx('k-select-opt', i === active && 'active')}
              onMouseEnter={() => setActive(i)}
              onMouseDown={e => e.preventDefault()}
              onClick={() => pick(g)}
            >
              <span className="k-select-opt-t">
                <span>{g.name}</span>
                <small>{guideDescription(g)}</small>
              </span>
              {g.id === value && <Icon name="check" size={14} />}
            </div>
          ))}
        </div>
      )}
    </div>
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
  compact,
}: {
  guide: ForwardingGuide
  mode: ForwardingMode
  e164: string
  compact?: boolean
}) {
  const steps = forwardingInstructions(guide, mode, e164)
  // A phone (touch first) dials with a tap; a laptop shows a QR code that opens the dialer on the phone. An iPhone
  // often refuses tel: links with * or #, so there Copy and paste into the keypad is the way.
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
        <p className="fg-none">{guide.note ?? `${guide.name} has no documented way to do this.`}</p>
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
            {mobile ? 'From your business cell phone, dial' : 'From your business line (the desk phone), dial'}
            {steps.on.length > 1 ? ' these one after the other:' : ':'}
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
                    {mobile && path === 'dial' && (
                      <a
                        className="k-btn k-btn-primary k-btn-sm"
                        href={c.href}
                        title="Open the phone’s dialer with this code (Enter)"
                      >
                        <Icon name="phone" size={14} />
                        <span>Dial</span>
                      </a>
                    )}
                    {mobile && !touch && steps.on.length > 1 && (
                      <button
                        type="button"
                        className="k-btn k-btn-ghost k-btn-sm"
                        aria-pressed={i === qrIndex}
                        title="Show this code as the QR code (Enter)"
                        onClick={() => setQrIndex(i)}
                      >
                        <span>Show QR</span>
                      </button>
                    )}
                    {mobile && path === 'copy' ? (
                      <CopyButton text={c.code} label="Copy, then paste into the Phone keypad" variant="primary" />
                    ) : (
                      <CopyButton text={c.code} label="Copy" />
                    )}
                  </span>
                </li>
              ))}
            </ol>
            {mobile && !touch && qrCode && (
              <figure className="fg-qr-box">
                <QrCode text={qrCode.href} label={`QR code that dials ${qrCode.code}`} />
                <figcaption>
                  Scan with your business phone’s camera to dial {qrCode.code}. On an iPhone, if the dialer stays empty,
                  type the code instead.
                </figcaption>
              </figure>
            )}
          </div>
          <p className="fg-meta">
            Turn it off with <code>{codesText(steps.off)}</code>
            {steps.check.length > 0 && (
              <>
                . Check it with <code>{codesText(steps.check)}</code>
              </>
            )}
            .
          </p>
        </>
      ) : (
        <>
          <p className="fg-lead">In {steps.where}:</p>
          <ol className="fg-steps">
            {steps.on.map(s => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <p className="fg-meta">
            To turn it off: {steps.off.join(' ')}
            {steps.check && ` Check it in ${steps.check}.`}
          </p>
        </>
      )}
      {guide.note && <p className="fg-meta">{guide.note}</p>}
      {(guide.pitfalls.length > 0 || (mobile && !compact)) && (
        <details className="fg-more" open={!compact}>
          <summary>Good to know</summary>
          <ul>
            {guide.pitfalls.map(p => (
              <li key={p}>{p}</li>
            ))}
            {mobile && !compact && (
              <li>Before testing, so your phone doesn’t answer first: {phoneChecklist.join(' ')}</li>
            )}
          </ul>
        </details>
      )}
      <Sources guide={guide} />
    </div>
  )
}

function Sources({ guide }: { guide: ForwardingGuide }) {
  return (
    <p className="fg-src">
      Source:{' '}
      {guide.sources.map((s, i) => (
        <span key={s.url}>
          {i > 0 && ', '}
          <a href={s.url} target="_blank" rel="noreferrer">
            {s.label}
          </a>
        </span>
      ))}
    </p>
  )
}
