// The start page (#start) of an instance admin without a workspace who chose the way by hand before (NoWorkspace.tsx):
// still AI agent first (the agent setup page, behind Server admin's passkey check); setting up by hand stays the clear, secondary alternative below: naming the business here, or
// the server's parts first when they are not set up (as AgentSetup's "Set up by hand instead").
// Naming the business waits for the passkey check too (POST /v1/workspaces answers 403 `admin_second_factor` before
// it): until then the way by hand offers that check, never a form the server would refuse.
import type { AgentSetupState } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { AdminSignInRequired, loadAgentSetup } from '../admin/api.ts'
import { SECOND_FACTOR_BUTTON, SecondFactorPrompt } from '../admin/SecondFactorPrompt.tsx'
import type { AdminSecondFactor } from '../auth.ts'
import { brandName } from '../brand.ts'
import { CreateWorkspace, LostWorkspace } from '../CreateWorkspace.tsx'
import { signOutAndForget } from '../localData.ts'
import { AuthPage, Button } from '../ui/kit.tsx'
import { Loading, LoadProblem, SkeletonFields } from '../ui/LoadStates.tsx'
import { openAgentSetup } from './AgentSetup.tsx'
import { installPartsMissing } from './agent-setup-passkey.ts'

type Props = {
  onDone: () => void
  lostWorkspace: string | null
  /** The admin chose the way by hand before: that part shows open; the agent still comes first. */
  byHandFirst: boolean
  /** The server's parts are not set up: by hand starts with them (the install walkthrough). */
  onInstallByHand: () => void
  /** The passkey check this session still has to pass (`me.adminSecondFactor`), null once it did. */
  secondFactor?: AdminSecondFactor | null
  /** Invitations and Open Server admin. */
  children?: ReactNode
}

export function AdminStart({
  onDone,
  lostWorkspace,
  byHandFirst,
  onInstallByHand,
  secondFactor = null,
  children,
}: Props) {
  const t = useT()
  const [state, setState] = useState<AgentSetupState | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  // Known from /v1/me, from the setup state's refusal (SECOND_FACTOR_REQUIRED) or from a refused creation.
  const [checkDue, setCheckDue] = useState<AdminSecondFactor | null>(secondFactor)
  const [prompting, setPrompting] = useState(false)
  const load = useCallback(async () => {
    setLoadFailed(false)
    try {
      setState(await loadAgentSetup())
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

  return (
    <AuthPage>
      <div className="auth-card as-start">
        {lostWorkspace && <LostWorkspace name={lostWorkspace} />}
        <h1>{t('onboarding.adminStart.title', { brand: brandName() })}</h1>
        <section className="as-card">
          <ol className="as-steps">
            <li>
              <b>{t('onboarding.adminStart.agent')}</b>
              <span className="as-small">{t('onboarding.adminStart.agentHelp')}</span>
              <div>
                <Button variant="primary" onClick={openAgentSetup} title={t('onboarding.adminStart.agentTip')}>
                  {t('onboarding.adminStart.agentButton')}
                </Button>
              </div>
            </li>
          </ol>
        </section>
        {byHand ? (
          <div className="as-byhand">
            <h2 className="as-byhand-title">{t('onboarding.adminStart.byHandTitle')}</h2>
            <ByHand
              state={state}
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
          <button
            type="button"
            className="as-manual as-manual-center"
            onClick={() => setByHand(true)}
            title={t('onboarding.adminStart.byHandTip')}
          >
            {t('onboarding.adminStart.byHand')}
          </button>
        )}
        {children}
        <button type="button" className="auth-switch" onClick={() => void signOutAndForget().then(onDone)}>
          {t('onboarding.adminStart.otherAccount')}
        </button>
      </div>
    </AuthPage>
  )
}

/**
 * The way by hand: the passkey check while it is due, then (once the setup state is known) the server's parts when
 * they are missing, else naming the business. Never the form while the state is loading; when loading it failed (and
 * no check is due), the error with Try again, and naming the business below it (the server still decides).
 */
export function ByHand({
  state,
  checkDue,
  loadFailed,
  onConfirm,
  onRetry,
  onInstallByHand,
  onDone,
  onSecondFactor,
}: {
  state: AgentSetupState | null
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
        <div>
          <Button
            onClick={onConfirm}
            title={
              checkDue === 'email' ? t('onboarding.adminStart.checkTipEmail') : t('onboarding.adminStart.checkTip')
            }
          >
            {SECOND_FACTOR_BUTTON[checkDue]}
          </Button>
        </div>
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
      {state && installPartsMissing(state.progress.steps) ? (
        <>
          <p>{t('onboarding.adminStart.partsFirst')}</p>
          <div>
            <Button onClick={onInstallByHand} title={t('onboarding.adminStart.partsFirstTip')}>
              {t('onboarding.adminStart.partsFirstButton')}
            </Button>
          </div>
        </>
      ) : (
        <CreateWorkspace onDone={onDone} embedded onSecondFactor={onSecondFactor} />
      )}
    </Loading>
  )
}
