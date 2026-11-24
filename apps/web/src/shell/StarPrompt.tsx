// The GitHub star prompt: a small card at the bottom right, like the tour (a sheet along the bottom on phones),
// only over the inbox: never over a page, a call, a dialog or the tour. Star stars the repository
// in one click for members who signed in with GitHub (GitHub asks them to allow it, then they are back
// here), else opens it on GitHub; No thanks closes it for good, the close button only for this session. A star made here ends in a short burst
// of confetti in the app's own colors.
import { formatStarCount, type StarPrompt as Prompt, STAR_SCOPE } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { auth } from '../auth.ts'
import { useBrand } from '../brand.ts'
import { callAction } from '../settings/settings-api.ts'
import { Button, Icon } from '../ui/kit.tsx'
import {
  markGranting,
  markShown,
  msUntilDue,
  repoUrl,
  type StarCardState,
  shownThisSession,
  starCardOnScreen,
  starMove,
  starPitch,
  takeGrantReturn,
} from './starPrompt.ts'
import './star-prompt.css'

type State = StarCardState
const THANKS_MS = 4000

/** True once the session is two minutes old (msUntilDue); waits only while `enabled`. */
function useDue(enabled: boolean) {
  const [due, setDue] = useState(false)
  useEffect(() => {
    if (!enabled) return
    const timer = setTimeout(() => setDue(true), msUntilDue())
    return () => clearTimeout(timer)
  }, [enabled])
  return due
}

/** One burst from the card's corner; the library loads only here and is skipped for reduced motion. */
function celebrate() {
  const action = getComputedStyle(document.documentElement).getPropertyValue('--action').trim() || '#1c1917'
  void import('canvas-confetti')
    .then(({ default: confetti }) =>
      confetti({
        particleCount: 120,
        spread: 100,
        startVelocity: 36,
        gravity: 1.4,
        ticks: 140,
        origin: { x: 0.85, y: 0.9 },
        angle: 110,
        colors: [action, '#78716c', '#a8a29e', '#d6d3d1'],
        disableForReducedMotion: true,
      }),
    )
    .catch(() => {})
}

/** `quiet`: something else has the member's attention (a call, a page, the tour): wait. */
/** `prompt` null: not due (also right after the star, when the card still says thanks). */
export function StarPrompt({ prompt, quiet }: { prompt: Prompt | null; quiet: boolean }) {
  const t = useT()
  const [returned] = useState(() => takeGrantReturn(prompt))
  const [state, setState] = useState<State>(
    returned === 'refused' ? 'failed' : returned === 'starred' ? 'thanks' : 'waiting',
  )
  const { starCount } = useBrand()
  const due = useDue(Boolean(prompt) && state === 'waiting' && !shownThisSession())

  useEffect(() => {
    if (state === 'waiting' && due && !quiet) {
      markShown()
      setState('ask')
    }
  }, [state, due, quiet])

  useEffect(() => {
    if (returned === 'starred') celebrate()
  }, [returned])

  useEffect(() => {
    if (state !== 'thanks') return
    const timer = setTimeout(() => setState('closed'), THANKS_MS)
    return () => clearTimeout(timer)
  }, [state])

  async function grant() {
    setState('starring')
    markGranting()
    const res = await auth.linkSocial({
      provider: 'github',
      scopes: [STAR_SCOPE],
      callbackURL: window.location.href,
      errorCallbackURL: window.location.href,
    })
    if (res.error) setState('failed') // otherwise the browser is on its way to GitHub
  }

  function open() {
    if (!prompt) return
    window.open(repoUrl(prompt.repo), '_blank', 'noopener')
    void callAction('starPrompt.answer', { answer: 'opened' }).catch(() => {})
    setState('closed') // whether they star it there is theirs to say: no thanks for a star we cannot see
  }

  function dismiss() {
    void callAction('starPrompt.answer', { answer: 'dismissed' }).catch(() => {})
    setState('closed')
  }

  if (!starCardOnScreen(state, quiet)) return null
  if (state === 'thanks') {
    return (
      <section className="tour star-card" role="status" aria-live="polite">
        <h2>{t('shell.star.thanks')}</h2>
        <p>{t('shell.star.thanksLine', { product: 'Linedesk' })}</p>
      </section>
    )
  }
  if (!prompt) return null
  const failed = state === 'failed'
  const move = starMove(prompt)
  return (
    <section
      className="tour star-card"
      role="dialog"
      aria-label={t('shell.star.dialog', { product: 'Linedesk' })}
      aria-live="polite"
    >
      <Button
        size="sm"
        variant="ghost"
        icon="close"
        className="star-close"
        aria-label={t('common.action.close')}
        title={t('shell.star.closeTip')}
        onClick={() => setState('closed')}
      />
      <h2 className="star-title">
        <Icon name="heart" size={15} className="star-heart" />
        {t('shell.star.title', { product: 'Linedesk' })}
      </h2>
      <p>{failed ? t('shell.star.failed') : starPitch('Linedesk', starCount, formatStarCount)}</p>
      <div className="tour-foot">
        <span className="tour-count" />
        <Button size="sm" variant="ghost" onClick={dismiss} title={t('shell.star.dismissTip')}>
          {t('shell.star.dismiss')}
        </Button>
        {failed || move === 'open' ? (
          <Button
            size="sm"
            variant="primary"
            icon="star"
            onClick={open}
            title={t('shell.star.open', { repo: prompt.repo })}
          >
            {failed ? t('shell.star.openGitHub') : t('shell.star.button')}
          </Button>
        ) : (
          <Button
            busy={state === 'starring'}
            size="sm"
            variant="primary"
            icon="star"
            disabled={state === 'starring'}
            onClick={() => void grant()}
            title={t('shell.star.grantTip', { product: 'Linedesk' })}
          >
            {state === 'starring' ? t('shell.star.starring') : t('shell.star.button')}
          </Button>
        )}
      </div>
    </section>
  )
}
