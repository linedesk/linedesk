// The start page (#start) of an instance admin without a workspace who chose the way by hand before (NoWorkspace.tsx):
// still AI agent first (the agent setup page, behind Server admin's passkey check); setting up by hand stays the clear,
// secondary alternative below: naming the business here, or the server's parts first when they are not set up and the
// install walkthrough has not handled them yet (as AgentSetup's "Set up by hand instead", agent-setup-passkey.ts).
// It is a signed-in setup page, so it has the setup pages' one top bar (SetupTopBar: the logo, "By hand", the account
// menu with Sign out), around the same centred column as before; the column's buttons all take its full width.
// Naming the business waits for the passkey check too (POST /v1/workspaces answers 403 `admin_second_factor` before
// it): until then the way by hand offers that check, never a form the server would refuse.
import type { AgentSetupState, InstallProgress } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { AdminSignInRequired, loadAgentSetup, loadInstallSetup } from '../admin/api.ts'
import { SECOND_FACTOR_BUTTON, SecondFactorPrompt } from '../admin/SecondFactorPrompt.tsx'
import type { AdminSecondFactor } from '../auth.ts'
import { brandName } from '../brand.ts'
import { CreateWorkspace, LostWorkspace } from '../CreateWorkspace.tsx'
import { AiButton } from '../settings/AgentChange.tsx'
import { Button } from '../ui/kit.tsx'
import { Loading, LoadProblem, SkeletonFields } from '../ui/LoadStates.tsx'
import { openAgentSetup } from './AgentSetup.tsx'
import { installPartsMissing } from './agent-setup-passkey.ts'
import { SetupTopBar } from './SetupTopBar.tsx'
import './agent-setup.css'

/** What of the install walkthrough's progress says which server parts it handled (agent-setup-passkey.ts). */
type InstallWalk = Pick<InstallProgress, 'skipped' | 'setAsideAt' | 'finishedAt'>

type Props = {
  onDone: () => void
  lostWorkspace: string | null
  /** The admin chose the way by hand before: that part shows open; the agent still comes first. */
  byHandFirst: boolean
  /** The server's parts are not set up: by hand starts with them (the install walkthrough). */
  onInstallByHand: () => void
  /** The passkey check this session still has to pass (`me.adminSecondFactor`), null once it did. */
  secondFactor?: AdminSecondFactor | null
  /**
   * The admin left the install walkthrough in this tab just now (finished or "Finish later"): its parts count as
   * handled before the server's progress says so (its save does not hold the page, leave-install-setup.ts).
   */
  installLeft?: boolean
  /** Invitations and Open Server admin. */
  children?: ReactNode
}

export function AdminStart({
  onDone,
  lostWorkspace,
  byHandFirst,
  onInstallByHand,
  secondFactor = null,
  installLeft = false,
  children,
}: Props) {
  const t = useT()
  const [state, setState] = useState<AgentSetupState | null>(null)
  // Where the install walkthrough got to: a part it skipped, set aside or finished is handled (agent-setup-passkey.ts).
  const [install, setInstall] = useState<InstallProgress | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  // Known from /v1/me, from the setup state's refusal (SECOND_FACTOR_REQUIRED) or from a refused creation.
  const [checkDue, setCheckDue] = useState<AdminSecondFactor | null>(secondFactor)
  const [prompting, setPrompting] = useState(false)
  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      const [next, walkthrough] = await Promise.all([loadAgentSetup(), loadInstallSetup().catch(() => null)])
      setState(next)
      setInstall(walkthrough?.progress ?? null)
      // Server admin answered, so this session passed the check.
      setCheckDue(null)
    } catch (err) {
      if (err instanceof AdminSignInRequired) setCheckDue(err.state)
      else setLoadFailed(true)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const [byHand, setByHand] = useState(byHandFirst)
  // Back from the prompt: the start page again, with the check still offered by hand.
  if (prompting && checkDue) return <SecondFactorPrompt state={checkDue} onExit={() => setPrompting(false)} />

  const progress: InstallWalk | null = installLeft ? { skipped: [], setAsideAt: null, finishedAt: 'left' } : install
  return (
    <div className="ob as-home" role="main" aria-label={t('onboarding.adminStart.title', { brand: brandName() })}>
      <SetupTopBar label={t('onboarding.install.count')} />
      <div className="ob-main as-home-main">
        <div className="auth-card">
          {lostWorkspace && <LostWorkspace name={lostWorkspace} />}
          <h1>{t('onboarding.adminStart.title', { brand: brandName() })}</h1>
          <section className="as-card">
            <div className="as-link-step">
              <b>{t('onboarding.adminStart.agent')}</b>
              <span className="as-small">{t('onboarding.adminStart.agentHelp')}</span>
              <AiButton
                size="md"
                label={t('onboarding.adminStart.agentButton')}
                title={t('onboarding.adminStart.agentTip')}
                onClick={openAgentSetup}
              />
            </div>
          </section>
          {byHand ? (
            <div className="as-byhand">
              <h2 className="as-byhand-title">{t('onboarding.adminStart.byHandTitle')}</h2>
              <ByHand
                state={state}
                install={progress}
                checkDue={checkDue}
                loadFailed={loadFailed}
                onConfirm={() => setPrompting(true)}
                onRetry={() => void load()}
                onInstallByHand={onInstallByHand}
                onDone={onDone}
                onSecondFactor={due => {
                  setCheckDue(due)
                  setPrompting(true)
                }}
              />
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setByHand(true)} title={t('onboarding.adminStart.byHandTip')}>
              {t('onboarding.adminStart.byHand')}
            </Button>
          )}
          {/* Invitations, Open Server admin and Account settings. Sign out is in the top bar's account menu. */}
          {children}
        </div>
      </div>
    </div>
  )
}

/**
 * The way by hand: the passkey check while it is due, then (once the setup state is known) the server's parts when
 * they are missing, else naming the business. Never the form while the state is loading; when loading it failed (and
 * no check is due), the error with Try again, and naming the business below it (the server still decides).
 */
export function ByHand({
  state,
  install = null,
  checkDue,
  loadFailed,
  onConfirm,
  onRetry,
  onInstallByHand,
  onDone,
  onSecondFactor,
}: {
  state: AgentSetupState | null
  /** The install walkthrough's progress, when known: the parts it skipped, set aside or finished are handled. */
  install?: InstallWalk | null
  checkDue: AdminSecondFactor | null
  loadFailed: boolean
  onConfirm: () => void
  onRetry: () => void
  onInstallByHand: () => void
  onDone: () => void
  onSecondFactor: (state: AdminSecondFactor) => void
}) {
  const t = useT()
  if (checkDue)
    return (
      <>
        <p>
          {checkDue === 'email' ? t('onboarding.adminStart.checkFirstEmail') : t('onboarding.adminStart.checkFirst')}
        </p>
        <Button
          onClick={onConfirm}
          title={checkDue === 'email' ? t('onboarding.adminStart.checkTipEmail') : t('onboarding.adminStart.checkTip')}
        >
          {SECOND_FACTOR_BUTTON[checkDue]}
        </Button>
      </>
    )
  if (loadFailed && !state)
    return (
      <>
        <LoadProblem what={t('onboarding.adminStart.setupState')} onRetry={onRetry} />
        <p>{t('onboarding.adminStart.nameAnyway')}</p>
        <CreateWorkspace onDone={onDone} embedded onSecondFactor={onSecondFactor} />
      </>
    )
  return (
    <Loading
      what={t('onboarding.adminStart.setupState')}
      loading={!state}
      error={loadFailed}
      onRetry={onRetry}
      skeleton={<SkeletonFields fields={1} />}
    >
      {state && installPartsMissing(state.progress.steps, install) ? (
        <>
          <p>{t('onboarding.adminStart.partsFirst')}</p>
          <Button onClick={onInstallByHand} title={t('onboarding.adminStart.partsFirstTip')}>
            {t('onboarding.adminStart.partsFirstButton')}
          </Button>
        </>
      ) : (
        <CreateWorkspace onDone={onDone} embedded onSecondFactor={onSecondFactor} />
      )}
    </Loading>
  )
}
