// Help on demand (docs/design-principles.md, rule 15): a small "?" next to a heading or label, or at the right end
// inside a field, that opens a short explanation for the people who need it. Hover opens it, and so do a click, a tap
// and keyboard focus (hover alone is neither accessible nor there on a phone); Esc, a click outside and focus moving
// away close it. It lives in the top layer (floating.ts), so a dialog's scrolling body never cuts it off, and it can
// carry commands to copy and a "Learn more" link. Styles in form.css (k-help).
import { arrow, autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react-dom'
import { type FocusEvent, type ReactNode, useEffect, useId, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { hideFromTopLayer, showInTopLayer } from './floating.ts'
import { cx, Icon } from './kit.tsx'
import './form.css'
import { useT } from '@linedesk/i18n/react'

/** A command to copy: the line itself, and optionally a few words above it saying where it applies. */
export type HelpCommand = { code: string; label?: string }

export type HelpTipContent = {
  /** A short title, only when the text needs one. */
  title?: string
  /** One to three short sentences. */
  text?: ReactNode
  /** Commands to copy, each with its own Copy button. */
  commands?: readonly HelpCommand[]
  /** One short line after the commands, e.g. where else to look. */
  after?: ReactNode
  /** A page in the docs with more. */
  learnMore?: string
}

/** What a `help` prop takes: plain words, or the full content. */
export type HelpContent = string | HelpTipContent

export const helpContent = (help: HelpContent): HelpTipContent => (typeof help === 'string' ? { text: help } : help)

export type HelpTipState = { open: boolean; pinned: boolean }
export type HelpTipEvent = 'hover' | 'leave' | 'click' | 'focus' | 'blur' | 'escape' | 'outside'

const CLOSED: HelpTipState = { open: false, pinned: false }

/**
 * When the help is open. Hover and focus open it for as long as they last; a click (or a tap) pins it open until
 * the next click, Esc, a click outside or focus leaving it.
 */
export function helpTipReducer(state: HelpTipState, event: HelpTipEvent): HelpTipState {
  switch (event) {
    case 'hover':
    case 'focus':
      return state.open ? state : { open: true, pinned: false }
    case 'leave':
      return state.pinned ? state : CLOSED
    case 'click':
      return state.pinned ? CLOSED : { open: true, pinned: true }
    case 'blur':
    case 'escape':
    case 'outside':
      return state.open ? CLOSED : state
  }
}

/** Copies `text`; says whether it worked (a page without clipboard access lets the user select it instead). */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard,
): Promise<'copied' | 'failed'> {
  if (!clipboard) return 'failed'
  try {
    await clipboard.writeText(text)
    return 'copied'
  } catch {
    return 'failed'
  }
}

/** How long the pointer may take from the "?" to the open help before it closes. */
const LEAVE_MS = 150

type HelpTipProps = HelpTipContent & {
  /** The button's name for screen readers, e.g. "About the setup code". */
  label?: string
  /** At the right end inside a field (the field's wrapper is `k-has-help`, or the kit Input's `end`). */
  inField?: boolean
}

export function HelpTip({
  title,
  text,
  commands,
  after,
  learnMore,
  label,
  inField,
}: HelpTipProps) {
  const t = useT()
  const [state, send] = useReducer(helpTipReducer, CLOSED)
  const { open } = state
  const id = useId()
  const root = useRef<HTMLSpanElement>(null)
  const pop = useRef<HTMLSpanElement | null>(null)
  const arrowRef = useRef<HTMLSpanElement>(null)
  const leaveTimer = useRef(0)
  // A press inside (a Copy button, selecting a command) can move focus to the page in some browsers: not a leave.
  const pressing = useRef(false)
  const { refs, floatingStyles, placement, middlewareData } = useFloating({
    open,
    strategy: 'fixed',
    placement: 'top',
    whileElementsMounted: autoUpdate,
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 }), arrow({ element: arrowRef, padding: 8 })],
  })

  const hover = () => {
    clearTimeout(leaveTimer.current)
    send('hover')
  }
  const leave = () => {
    clearTimeout(leaveTimer.current)
    leaveTimer.current = window.setTimeout(() => send('leave'), LEAVE_MS)
  }
  useEffect(() => {
    const release = () => {
      pressing.current = false
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      clearTimeout(leaveTimer.current)
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [])

  useLayoutEffect(() => {
    const el = pop.current
    if (!open || !el) return
    showInTopLayer(el)
    return () => hideFromTopLayer(el)
  }, [open])

  // While open: Esc closes it first (before a dialog or a page behind it closes), and so does a click outside.
  useEffect(() => {
    if (!open) return
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (root.current?.contains(target) || pop.current?.contains(target))
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      send('escape')
    }
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target)) send('outside')
    }
    window.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown, true)
    }
  }, [open])

  // Focus leaving the "?" and the open help (not moving between them) closes it.
  const onBlur = (e: FocusEvent) => {
    if (pressing.current) return
    const next = e.relatedTarget
    if (!(next instanceof Node && (root.current?.contains(next) || pop.current?.contains(next)))) send('blur')
  }

  const interactive = Boolean(commands?.length || learnMore)
  const below = placement.startsWith('bottom')
  const tip = middlewareData.arrow
  return (
    <span ref={root} className={cx('k-help', inField && 'is-in-field')}>
      <button
        ref={refs.setReference}
        type="button"
        className="k-help-btn"
        aria-label={label ?? t('common.help.more')}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        // In a field, a click keeps the cursor where it is: the user can read and go on typing.
        onMouseDown={inField ? e => e.preventDefault() : undefined}
        onClick={() => send('click')}
        onPointerEnter={e => e.pointerType === 'mouse' && hover()}
        onPointerLeave={e => e.pointerType === 'mouse' && leave()}
        onFocus={() => send('focus')}
        onBlur={onBlur}
      >
        <span className="k-help-q" aria-hidden="true">
          ?
        </span>
      </button>
      {open && (
        <span
          ref={el => {
            pop.current = el
            refs.setFloating(el)
          }}
          popover="manual"
          // A non-modal dialog, not a tooltip: it can hold buttons and a link. The "?" describes itself by it.
          role="dialog"
          aria-label={title ?? label ?? t('common.help.more')}
          id={id}
          className={cx('k-help-pop', interactive && 'is-rich')}
          style={floatingStyles}
          onPointerEnter={e => e.pointerType === 'mouse' && hover()}
          onPointerLeave={e => e.pointerType === 'mouse' && leave()}
          onPointerDownCapture={() => {
            pressing.current = true
          }}
          onBlur={onBlur}
        >
          <HelpBody title={title} text={text} commands={commands} after={after} learnMore={learnMore} />
          <span
            ref={arrowRef}
            className={cx('k-help-arrow', below && 'is-below')}
            style={{ left: tip?.x != null ? `${tip.x}px` : undefined }}
          />
        </span>
      )}
    </span>
  )
}

/** What the open help shows: title, words, commands to copy and the docs link. */
export function HelpBody({ title, text, commands, after, learnMore }: HelpTipContent) {
  const t = useT()
  return (
    <>
      {title && <span className="k-help-title">{title}</span>}
      {text && <span className="k-help-text">{text}</span>}
      {commands?.map(c => (
        <span key={c.code} className="k-help-cmd">
          {c.label && <span className="k-help-cmd-label">{c.label}</span>}
          <span className="k-help-cmd-line">
            <code>{c.code}</code>
            <CopyCommand code={c.code} />
          </span>
        </span>
      ))}
      {after && <span className="k-help-text">{after}</span>}
      {learnMore && (
        <a className="k-help-more" href={learnMore} target="_blank" rel="noreferrer">
          {t('common.help.learnMore')}
        </a>
      )}
    </>
  )
}

function CopyCommand({ code }: { code: string }) {
  const t = useT()
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 1600)
    return () => clearTimeout(timer)
  }, [state])
  return (
    <button
      type="button"
      className="k-help-copy"
      aria-label={state === 'copied' ? t('common.copy.copied') : t('common.copy.copyThis', { text: code })}
      onClick={() => void copyText(code).then(setState)}
    >
      {state === 'copied' && <Icon name="check" size={12} />}
      <span aria-live="polite">{state === 'copied' ? t('common.copy.copied') : state === 'failed' ? t('common.copy.selectIt') : t('common.copy.copy')}</span>
    </button>
  )
}
