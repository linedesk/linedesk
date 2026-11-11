// The GitHub star prompt: a small card at the bottom right, like the tour. Star stars the repository
// in one click for members who signed in with GitHub (GitHub asks them to allow it, then they are back
// here), else opens it on GitHub; No thanks closes it for good.
import { type StarPrompt as Prompt, STAR_SCOPE } from '@linedesk/actions'
import { useEffect, useState } from 'react'
import { auth } from '../auth.ts'
import { callAction } from '../settings/settings-api.ts'
import { Button } from '../ui/kit.tsx'
import {
  markGranting,
  markShown,
  repoUrl,
  STAR_IDLE_MS,
  shownThisSession,
  starMove,
  takeGrantReturn,
} from './starPrompt.ts'

/** `waiting`: not shown yet; `closed`: answered or thanked, gone for this page. */
type State = 'waiting' | 'ask' | 'starring' | 'thanks' | 'failed' | 'closed'
const THANKS_MS = 4000

/** True once the page has been quiet (no key, pointer or scroll) for `ms`. */
function useIdle(ms: number, enabled: boolean) {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    if (!enabled) return
    let timer = setTimeout(() => setIdle(true), ms)
    const reset = () => {
      clearTimeout(timer)
      timer = setTimeout(() => setIdle(true), ms)
    }
    const events = ['keydown', 'pointerdown', 'pointermove', 'wheel'] as const
    for (const e of events) window.addEventListener(e, reset, { passive: true })
    return () => {
      clearTimeout(timer)
      for (const e of events) window.removeEventListener(e, reset)
    }
  }, [ms, enabled])
  return idle
}

/** `quiet`: something else has the member's attention (a call, a page, the tour): wait. */
/** `prompt` null: not due (also right after the star, when the card still says thanks). */
export function StarPrompt({ prompt, quiet }: { prompt: Prompt | null; quiet: boolean }) {
  const [returned] = useState(() => takeGrantReturn(prompt))
  const [state, setState] = useState<State>(
    returned === 'refused' ? 'failed' : returned === 'starred' ? 'thanks' : 'waiting',
  )
  const idle = useIdle(STAR_IDLE_MS, Boolean(prompt) && state === 'waiting' && !shownThisSession())

  useEffect(() => {
    if (state === 'waiting' && idle && !quiet) {
      markShown()
      setState('ask')
    }
  }, [state, idle, quiet])

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
      <h2>Enjoying Linedesk?</h2>
      <p>
        {failed
          ? 'That did not work from here. You can star it on GitHub instead.'
          : 'Linedesk is open source. A star on GitHub helps others find it.'}
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
          <Button
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
