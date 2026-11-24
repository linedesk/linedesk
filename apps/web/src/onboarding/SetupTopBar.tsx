// The one top bar of every setup page (2026-11-18, docs/design-principles.md): the onboarding's steps (Frame.tsx), the
// install by hand (InstallSetup.tsx) and the AI agent setup pages (AgentSetup.tsx), also when they are gone through
// again from the settings (StepByStep.tsx, settings/ChangeWithAgent.tsx). Logo and product name on the left; on the
// right, in this order: where the person is ("Step n of m · Name", or what the page is), "Set up with AI" (the AI button, settings/AgentChange.tsx) where
// there is an agent path, the way out ("Finish later" while setting up, "Close" from the settings) and the account
// menu. Under it a 2 px line: how far the steps got, (n − 1) / (m − 1), the last step full.
import { useT } from '@linedesk/i18n/react'
import { type ReactNode, useEffect, useRef } from 'react'
import { brandName, installBrandName } from '../brand.ts'
import { AiButton } from '../settings/AgentChange.tsx'
import { SetupAccountMenu } from '../shell/SetupAccountMenu.tsx'
import { BrandMark, Button, cx } from '../ui/kit.tsx'

/** Where the person is in a counted walkthrough: step `n` of `m`, named. */
export type SetupStepCount = { n: number; m: number; name: string }

/**
 * The way out of the page. `finish-later`: leave setup now and finish it later (what is left waits in the go-live
 * checklist or in Server admin); `close`: back to the settings the steps were opened from. Shift+Esc does it too.
 */
export type SetupExit = { kind: 'finish-later' | 'close'; onExit: () => void; title?: string }

/** How full the line under the bar is, in percent: step 1 empty, the last step full; `ahead` counts the step as done. */
export function setupProgress({ n, m }: Pick<SetupStepCount, 'n' | 'm'>, ahead = false): number {
  if (m <= 1) return 100
  const at = Math.min(m - 1, Math.max(0, n - 1 + (ahead ? 1 : 0)))
  return Math.round((at / (m - 1)) * 100)
}

export type SetupTopBarProps = {
  /** A counted walkthrough: "Step n of m · Name" (and "n/m" on a phone), the line filled by setupProgress. */
  step?: SetupStepCount
  /** A page that is no counted walkthrough (the agent pages): what it is, in place of the step count. */
  label?: string
  /** The line's fill in percent, where it is not the step's (the agent page: how much of its checklist is done). */
  progress?: number
  /** The step is done already (a number bought on the phone step): the line shows the next step's fill. */
  ahead?: boolean
  /** "Set up with AI": back to the agent setup page, which goes on from what is saved. */
  agentPath?: () => void
  /** The way out; left out only where leaving is impossible (before the trial's checkout). */
  exit?: SetupExit | null
  /** `install`: the install's own brand, never a white-label one (a partner's own setup). */
  brand?: 'app' | 'install'
  /** The account menu's workspace, where the page is not the tab's (SetupAccountMenu). */
  workspaceId?: string | null
  /** A page outside the open workspace (a partner's setup): every workspace is somewhere else to go. */
  away?: boolean
}

export function SetupTopBar({
  step,
  label,
  progress,
  ahead = false,
  agentPath,
  exit = null,
  brand = 'app',
  workspaceId,
  away = false,
}: SetupTopBarProps) {
  const t = useT()
  const install = brand === 'install'
  const fill = progress ?? (step ? setupProgress(step, ahead) : 0)
  // Shift+Esc leaves, as the button does.
  const exitRef = useRef(exit)
  exitRef.current = exit
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || !e.shiftKey || e.isComposing || !exitRef.current) return
      e.preventDefault()
      exitRef.current.onExit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <>
      <div className="ob-top">
        <BrandMark install={install} />
        <b>{install ? installBrandName() : brandName()}</b>
        {step ? (
          <>
            <span className="ob-count">
              {t('onboarding.frame.stepCount', { step: step.n, total: step.m, label: step.name })}
            </span>
            {/* A phone's top bar: the count alone, next to the account menu. */}
            <span className="ob-count-short" aria-hidden="true">
              {t('onboarding.frame.stepShort', { step: step.n, total: step.m })}
            </span>
          </>
        ) : (
          <span className="ob-count ob-count-label">{label}</span>
        )}
        {agentPath && (
          <AiButton
            className="ob-agent"
            label={t('onboarding.frame.agent')}
            spark
            title={t('onboarding.frame.agentTitle')}
            onClick={agentPath}
          />
        )}
        {exit && (
          <Button
            size="sm"
            variant="ghost"
            onClick={exit.onExit}
            title={
              exit.title ??
              t(exit.kind === 'close' ? 'onboarding.frame.closeTitle' : 'onboarding.frame.finishLaterTitle')
            }
          >
            {exit.kind === 'close' ? (
              t('onboarding.frame.close')
            ) : (
              <>
                <span className="ob-exit-full">{t('onboarding.frame.finishLater')}</span>
                {/* A phone's top bar: one word, so the AI button keeps its text. */}
                <span className="ob-exit-short">{t('onboarding.frame.finishLaterShort')}</span>
              </>
            )}
          </Button>
        )}
        {/* Sign out or another workspace, on every setup page: there is no other navigation here. */}
        <SetupAccountMenu workspaceId={workspaceId} away={away} />
      </div>
      <div className="ob-bar">
        <span style={{ width: `${fill}%` }} />
      </div>
    </>
  )
}

/**
 * The page of every setup (the onboarding's Frame, the install by hand, the agent setup, the partner setup, a Checkout's
 * result, the admin start): the main region named for the screen reader, the shared top bar (`bar`, a SetupTopBar), the
 * content column (`.ob-main`, its footer inside) and what must come after it (`after`: a dialog host that opens over
 * the page's own dialogs).
 */
export function SetupPage({
  label,
  className,
  mainClassName,
  busy,
  bar,
  after,
  children,
}: {
  /** The page's name for the screen reader. */
  label: string
  /** Besides `ob`: the page's own look (`is`, `as`), `k-install-brand` for the install's own brand. */
  className?: string | false
  mainClassName?: string
  /** Loading the page: `aria-busy` while only placeholders show. */
  busy?: boolean
  bar: ReactNode
  after?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={cx('ob', className)} role="main" aria-label={label} aria-busy={busy || undefined}>
      {bar}
      <div className={cx('ob-main', mainClassName)}>{children}</div>
      {after}
    </div>
  )
}
