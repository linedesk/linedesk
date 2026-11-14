// What the admin finishes right on the agent setup page (AgentSetup.tsx), never sent into the app: the test call (the
// same call and side panel as Settings › Assistant, TestCall.tsx) and the call forwarding (the same dialog as Settings ›
// Phone numbers). Both act in the business's workspace, so each opens that workspace's local store on the first click,
// not with the page: most admins never need it here.
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { ManageNumber } from '../settings/PhoneNumbers.tsx'
import { useTestCall } from '../settings/TestCall.tsx'
import { TestCallPanel } from '../settings/TestCallPanel.tsx'
import { StoreProvider, useAssistants, useRows } from '../store.tsx'
import { Button } from '../ui/kit.tsx'

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

const TEST_CALL_TITLE = 'Talk to your assistant with your microphone, right here'

/**
 * "Call Maya now" on the Test call row: starts the browser test call at once (microphone, live call, hang up in the
 * side panel). `onCalled` once the assistant answered (its first line has arrived): the row shows done at once.
 */
export function SetupTestCall({
  workspace,
  assistantName,
  done,
  onCalled,
}: {
  workspace: SetupWorkspace
  assistantName: string
  done: boolean
  onCalled: () => void
}) {
  // Bumped by every click: the call starts on it, also again after the panel was closed.
  const [asked, setAsked] = useState(0)
  const label = done ? 'Call again' : `Call ${assistantName} now`
  const variant = done ? 'ghost' : 'primary'
  if (!asked)
    return (
      <Button size="sm" variant={variant} icon="phone-in" title={TEST_CALL_TITLE} onClick={() => setAsked(1)}>
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
          title={session.blockedReason ? undefined : TEST_CALL_TITLE}
          onClick={onAsk}
        >
          {session.phase === 'live' ? 'On the call' : label}
        </Button>
      </span>
      {/* No Open in inbox: the setup page stays where it is; the call is in the inbox afterwards. */}
      <TestCallPanel session={session} onOpenCall={null} onStart={onAsk} />
    </>
  )
}

/**
 * "Set up forwarding" on the Call forwarding row: the number's dialog from Settings › Phone numbers (codes for the
 * carrier, then "Check forwarding", which calls the business line and marks the step done once the call arrives).
 */
export function SetupForwarding({ workspace, onClosed }: { workspace: SetupWorkspace; onClosed: () => void }) {
  const [open, setOpen] = useState(false)
  const button = (busy: boolean) => (
    <Button
      size="sm"
      variant="secondary"
      busy={busy}
      disabled={busy}
      title="The codes for your carrier, then a check that calls reach your assistant"
      onClick={() => setOpen(true)}
    >
      Set up forwarding
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
  const number = useRows('phone_numbers').find(n => n.mode === 'forward_conditional' || n.mode === 'forward_all')
  const assistants = useAssistants()
  // The numbers arrive with the store's first sync: until then the button stays busy.
  if (!number) return busy
  return (
    <>
      {busy}
      <ManageNumber number={number} assistants={assistants} canEdit onClose={onClose} />
    </>
  )
}
