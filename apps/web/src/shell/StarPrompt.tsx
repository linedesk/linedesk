// The GitHub star prompt: a small card at the bottom right, like the tour. Star stars the repository
// in one click for members who signed in with GitHub (GitHub asks them to allow it, then they are back
// here), else opens it on GitHub; No thanks closes it for good, the close button only for this session. A star made here ends in a short burst
// of confetti in the app's own colors.
import { formatStarCount, type StarPrompt as Prompt, STAR_SCOPE } from '@linedesk/actions'
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
  shownThisSession,
  starMove,
  starPitch,
  takeGrantReturn,
} from './starPrompt.ts'

/** `waiting`: not shown yet; `closed`: answered or thanked, gone for this page. */
type State = 'waiting' | 'ask' | 'starring' | 'thanks' | 'failed' | 'closed'
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

  if (state === 'waiting' || state === 'closed') return null
  if (state === 'thanks') {
    return (
      <section className="tour star-card" role="status" aria-live="polite">
        <h2>Thanks for the star.</h2>
        <p>It helps other businesses find Linedesk.</p>
      </section>
    )
  }
  if (!prompt) return null
  const failed = state === 'failed'
  const move = starMove(prompt)
  return (
    <section className="tour star-card" role="dialog" aria-label="Star Linedesk on GitHub" aria-live="polite">
      <Button
        size="sm"
        variant="ghost"
        icon="close"
        className="star-close"
        aria-label="Close"
        title="Close for now"
        onClick={() => setState('closed')}
      />
      <h2 className="star-title">
        <Icon name="heart" size={15} className="star-heart" />
        Support Linedesk
      </h2>
      <p>
        {failed
          ? 'That did not work from here. You can star it on GitHub instead.'
          : starPitch('Linedesk', starCount, formatStarCount)}
      </p>
      <div className="tour-foot">
        <span className="tour-count" />
        <Button size="sm" variant="ghost" onClick={dismiss} title="Don't ask again">
          No thanks
        </Button>
        {failed || move === 'open' ? (
          <Button size="sm" variant="primary" icon="star" onClick={open} title={`Open ${prompt.repo} on GitHub`}>
            {failed ? 'Open GitHub' : 'Star on GitHub'}
          </Button>
        ) : (
          <Button busy={state === 'starring'}
            size="sm"
            variant="primary"
            icon="star"
            disabled={state === 'starring'}
            onClick={() => void grant()}
            title="GitHub asks you to allow starring, then you are back here. Linedesk gives the permission up right after."
          >
            {state === 'starring' ? 'Starring…' : 'Star on GitHub'}
          </Button>
        )}
      </div>
    </section>
  )
}
