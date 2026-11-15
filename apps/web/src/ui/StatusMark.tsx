// One mark for "does it work": a check in a filled circle when it works, an exclamation mark when it partly works,
// a cross when it fails, an empty circle when it is not set up (or not tested, not needed, off), the spinner while it
// is being checked. The shape differs per state, so colour is never the only signal; each mark has its words as an
// accessible label and a tooltip. Used wherever a screen says whether something works (design-principles.md,
// "Status marks"): Server admin › Providers, the overview's "Ready for calls" card, the provider dialog, the install
// walkthrough, System, Calendar, Webhooks.
import { type StatusState, statusWords } from '@linedesk/actions'
import { cx, Icon, Spinner } from './kit.tsx'
import './status-mark.css'

export type MarkKind = 'works' | 'partly' | 'failing' | 'empty' | 'busy'

/** The shapes drawn inside a circle: check, exclamation mark, cross. */
export type GlyphKind = 'works' | 'partly' | 'failing'
const glyphIcons = { works: 'check', partly: 'exclamation', failing: 'close' } as const

/**
 * The one way to draw a glyph inside a circle (StatusMark, the setup page's step marks, Try it's result, the go-live
 * checklist). Always an icon, never a text character: a text "!" sits wherever its font's ascent, descent and the
 * inherited line-height put it (a pixel low in a 20px row), while each icon's ink is centred on its viewBox, so the
 * circle's `place-items: center` centres the ink itself, at any size and pixel ratio. Same stroke everywhere
 * (status-mark.css, `.k-mark-glyph`), whatever the icon's size.
 */
export function MarkGlyph({ kind, size }: { kind: GlyphKind; size: number }) {
  return <Icon name={glyphIcons[kind]} size={size} className="k-mark-glyph" />
}

/** The shape a state is drawn with. */
export const markKind = (state: StatusState): MarkKind =>
  state === 'works'
    ? 'works'
    : state === 'partly'
      ? 'partly'
      : state === 'failing'
        ? 'failing'
        : state === 'checking'
          ? 'busy'
          : 'empty'

type Props = {
  state: StatusState
  /** The words for screen readers and the tooltip; default: the state's own ("Works", "Failing", "Not set up"). */
  label?: string
  className?: string
}

export function StatusMark({ state, label, className }: Props) {
  const kind = markKind(state)
  const words = label ?? statusWords[state]
  if (kind === 'busy')
    return (
      <span className={cx('k-mark', 'k-mark-busy', className)} role="img" aria-label={words} title={words}>
        <Spinner />
      </span>
    )
  return (
    <span className={cx('k-mark', `k-mark-${kind}`, className)} role="img" aria-label={words} title={words}>
      {kind === 'empty' ? null : <MarkGlyph kind={kind} size={10} />}
    </span>
  )
}
