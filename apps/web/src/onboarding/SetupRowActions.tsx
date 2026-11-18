// What the admin finishes right on the agent setup page (AgentSetup.tsx), never sent into the app: the test call (the
// same call and side panel as Settings › Assistant, TestCall.tsx), the call forwarding (the same dialog as Settings ›
// Phone numbers) and, for a sign-up waiting for its trial, starting it (the onboarding's activation step, in a dialog). Both act in the business's workspace, so each opens that workspace's local store on the first click,
// not with the page: most admins never need it here.
import { msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { AppLink, LinkButton } from '../ui/AppLink.tsx'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ManageNumber } from '../settings/PhoneNumbers.tsx'
import { useTestCall } from '../settings/TestCall.tsx'
import { TestCallPanel } from '../settings/TestCallPanel.tsx'
import { StoreProvider, useAssistants, useRows, useStore } from '../store.tsx'
import type { Activation, Me } from '../auth.ts'
import { Dialog } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { ActivatePlan, useStartTrial } from './ActivateStep.tsx'
import { sectionHash } from '../ui/SettingsLayout.tsx'
import { isForwarded, type NumberMissing, waitForForwardedNumber } from './forwarded-number.ts'

/** The workspace the business steps are about, as this tab works in it (the store and requests act there). */
export type SetupWorkspace = { id: string; account: string }

/** The store of the setup's workspace, opened for one control; while it opens, the control shows as busy. */
function InWorkspace({
  workspace,
  busy,
  children,
}: {
  workspace: SetupWorkspace
  busy: ReactNode
  children: ReactNode
}) {
  return (
    <StoreProvider workspaceId={workspace.id} account={workspace.account} fallback={busy}>
      {children}
    </StoreProvider>
  )
}

const TEST_CALL_TITLE = msg('onboarding.rowActions.testCallTitle')

/**
 * "Call Maya now" on the Test call row: starts the browser test call at once (microphone, live call, hang up in the
 * side panel). `onCalled` once the assistant answered (its first line has arrived): the row shows done at once.
 */
export function SetupTestCall({
  workspace,
  assistantName,
  done,
  onCalled,
  autoStart = false,
}: {
  workspace: SetupWorkspace
  assistantName: string
  done: boolean
  onCalled: () => void
  /** The admin clicked it before the tab switched into this workspace: the call starts at once (resume-after-switch.ts). */
  autoStart?: boolean
}) {
  const t = useT()
  // Bumped by every click: the call starts on it, also again after the panel was closed.
  const [asked, setAsked] = useState(autoStart ? 1 : 0)
  const label = done
    ? t('onboarding.rowActions.callAgain')
    : t('onboarding.rowActions.callNow', { name: assistantName })
  const variant = done ? 'ghost' : 'primary'
  if (!asked)
    return (
      <Button size="sm" variant={variant} icon="phone-in" title={t(TEST_CALL_TITLE)} onClick={() => setAsked(1)}>
        {label}
      </Button>
    )
  return (
    <InWorkspace
      workspace={workspace}
      busy={
        <Button size="sm" variant={variant} icon="phone-in" busy disabled>
          {label}
        </Button>
      }
    >
      <TestCallHere
        label={label}
        variant={variant}
        asked={asked}
        onAsk={() => setAsked(n => n + 1)}
        onCalled={onCalled}
      />
    </InWorkspace>
  )
}

function TestCallHere({
  label,
  variant,
  asked,
  onAsk,
  onCalled,
}: {
  label: string
  variant: 'primary' | 'ghost'
  asked: number
  onAsk: () => void
  onCalled: () => void
}) {
  const t = useT()
  // The admin is an instance admin: when nobody answers, the panel says what to fix on the server.
  const session = useTestCall(true, undefined, true)
  const started = useRef(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: starts once per click (`asked`), not on every render
  useEffect(() => {
    if (started.current === asked || session.blockedReason) return
    started.current = asked
    session.start()
  }, [asked, session.blockedReason])
  // The assistant said something: it answered (a call it could not take is filed too, as missed).
  const called = session.lines.some(line => line.speaker === 'agent')
  const told = useRef(false)
  useEffect(() => {
    if (!called || told.current) return
    told.current = true
    onCalled()
  }, [called, onCalled])
  const busy = session.phase === 'starting' || session.phase === 'live'
  return (
    <>
      <span title={session.blockedReason ?? undefined}>
        <Button
          size="sm"
          variant={variant}
          icon="phone-in"
          busy={session.phase === 'starting'}
          disabled={busy || Boolean(session.blockedReason)}
          title={session.blockedReason ? undefined : t(TEST_CALL_TITLE)}
          onClick={onAsk}
        >
          {session.phase === 'live' ? t('onboarding.rowActions.onCall') : label}
        </Button>
      </span>
      {/* No Open in inbox: the setup page stays where it is; the call is in the inbox afterwards. */}
      <TestCallPanel session={session} onOpenCall={null} onStart={onAsk} />
    </>
  )
}

/**
 * "Set up forwarding" on the Call forwarding row: the number's dialog from Workspace settings › Phone numbers (codes for the
 * carrier, then "Check forwarding", which calls the business line and marks the step done once the call arrives).
 */
export function SetupForwarding({
  workspace,
  onClosed,
  autoOpen = false,
}: {
  workspace: SetupWorkspace
  onClosed: () => void
  /** The admin clicked it before the tab switched into this workspace: the dialog opens at once. */
  autoOpen?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(autoOpen)
  const button = (busy: boolean) => (
    <Button
      size="sm"
      variant="secondary"
      busy={busy}
      disabled={busy}
      title={t('onboarding.rowActions.forwardingTitle')}
      onClick={() => setOpen(true)}
    >
      {t('onboarding.rowActions.forwarding')}
    </Button>
  )
  if (!open) return button(false)
  const close = () => {
    setOpen(false)
    onClosed()
  }
  return (
    <InWorkspace workspace={workspace} busy={button(true)}>
      <ForwardingDialog busy={button(true)} onClose={close} />
    </InWorkspace>
  )
}

function ForwardingDialog({ busy, onClose }: { busy: ReactNode; onClose: () => void }) {
  const number = useRows('phone_numbers').find(isForwarded)
  const assistants = useAssistants()
  const store = useStore()
  // The numbers may still be on their way (read sync): the button stays busy a few seconds at most, then says why.
  const [missing, setMissing] = useState<NumberMissing | null>(null)
  const [attempt, setAttempt] = useState(0)
  // Waits again when the number stops forwarding while the dialog is open (its use changed to a number of its own).
  const found = Boolean(number)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is Try again: it waits once more
  useEffect(() => {
    if (found) return
    setMissing(null)
    const wait = waitForForwardedNumber(store)
    void wait.done.then(setMissing)
    return wait.cancel
  }, [store, attempt, found])
  if (number)
    return (
      <>
        {busy}
        <ManageNumber number={number} assistants={assistants} canEdit onClose={onClose} />
      </>
    )
  if (missing) return <ForwardingMissing missing={missing} onRetry={() => setAttempt(n => n + 1)} />
  return busy
}

/** In place of "Set up forwarding" when its dialog cannot open: why, and where the numbers are. */
export function ForwardingMissing({ missing, onRetry }: { missing: NumberMissing; onRetry: () => void }) {
  const t = useT()
  return (
    <span className="as-small" role="status">
      {missing === 'none' ? t('onboarding.rowActions.noForwarded') : t('onboarding.rowActions.numbersNotLoaded')}{' '}
      {missing === 'not_loaded' && (
        <>
          <LinkButton onClick={onRetry}>{t('common.action.tryAgain')}</LinkButton>
          {' · '}
        </>
      )}
      <AppLink to={sectionHash('workspace', 'phone')}>{t('onboarding.rowActions.phoneNumbersLink')}</AppLink>
    </span>
  )
}

/**
 * "Start free trial" on the Start your trial row of the owner's agent setup page (docs/billing.md §3.2): the owner's own
 * step, never the agent's. The same plan, timeline and terms as the onboarding's activation step, in a dialog; its button
 * goes to Stripe Checkout, and back from it this page opens again with the number next.
 */
export function SetupStartTrial({ me, onTermsChanged }: { me: Me; onTermsChanged: () => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const activation = me.workspace?.activation
  if (!activation) return null
  const label = activation.trialDays !== null ? t('onboarding.activate.startTrial') : t('onboarding.activate.startPlan')
  return (
    <>
      <Button size="sm" variant="primary" title={t('onboarding.activate.cardHint')} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <StartTrialDialog
          me={me}
          activation={activation}
          onTermsChanged={onTermsChanged}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function StartTrialDialog({
  me,
  activation,
  onTermsChanged,
  onClose,
}: {
  me: Me
  activation: Activation
  onTermsChanged: () => void
  onClose: () => void
}) {
  const t = useT()
  // Back from Checkout: this page again (the owner did not choose by hand).
  const trial = useStartTrial(me, activation, onTermsChanged, { byHand: false })
  return (
    <Dialog
      title={trial.title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={trial.busy}>
            {t('common.action.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={trial.busy}
            disabled={!activation.terms}
            title={t('onboarding.activate.cardHint')}
            onClick={() => void trial.start()}
          >
            {trial.label}
          </Button>
        </>
      }
    >
      <ActivatePlan activation={activation} trial={trial} />
    </Dialog>
  )
}
