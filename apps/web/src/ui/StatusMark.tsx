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
      {kind === 'works' ? (
        <Icon name="check" size={10} />
      ) : kind === 'failing' ? (
        <Icon name="close" size={10} />
      ) : kind === 'partly' ? (
        <span className="k-mark-bang" aria-hidden="true">
          !
        </span>
      ) : null}
    </span>
  )
}
