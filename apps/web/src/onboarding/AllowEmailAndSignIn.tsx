// Your agent asks to set up email and sign-in (setup-mcp.ts PASSKEY_NEEDED gives the admin <app>/#setup-agent?allow=<keyId>):
// the agent setup page opens this dialog at once for that key. It names the setup link, says what it may then change,
// and "Allow with passkey" asks for the passkey before the grant (allow-email-and-sign-in.ts). Closed, the request
// stays on the page as a note with the same button; allowed, the note says so with Withdraw.
import type { AgentSetupState } from '@linedesk/actions'
import { useState } from 'react'
import { runAdminOnce } from '../admin/api.ts'
import { passkeySupported, signInWithPasskey } from '../auth.ts'
import { Dialog } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { untilLabel } from '../time.ts'
import { type AllowResult, allowWithPasskey } from './allow-email-and-sign-in.ts'

type LinkKey = NonNullable<AgentSetupState['key']>
const timeOf = (iso: string) => untilLabel(new Date(iso))

const steps = {
  supported: passkeySupported,
  signIn: signInWithPasskey,
  confirm: (keyId: string) => runAdminOnce('agentSetup.confirmPasskey', { keyId }),
}

/** The dialog's state: open or not, busy, and why the last try did not allow it. */
export function useAllow(onAllowed: (until: string | null) => void) {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Extract<AllowResult, { ok: false }> | null>(null)
  const allow = async (keyId: string) => {
    setBusy(true)
    setProblem(null)
    const result = await allowWithPasskey(keyId, steps)
    setBusy(false)
    if (result.ok) onAllowed(result.until)
    else setProblem(result)
  }
  return { busy, problem, allow, clear: () => setProblem(null) }
}
export type Allow = ReturnType<typeof useAllow>

/** The request on the page, for when the dialog was closed: a note with the same button. */
export function AllowRequestNote({ linkKey, onOpen }: { linkKey: LinkKey; onOpen: () => void }) {
  return (
    <Note
      tone="warning"
      className="as-allow-note"
      title="Your agent asks to set up email and sign-in"
      action={
        <Button
          variant="primary"
          size="sm"
          onClick={onOpen}
          title={`Confirm with your passkey: your agent can then set up email and sign-in with ${linkKey.prefix}…`}
        >
          Allow with passkey
        </Button>
      }
    >
      With setup link <b>{linkKey.prefix}…</b>, created {timeOf(linkKey.createdAt)}.
    </Note>
  )
}

/** Allowed: until when, with Withdraw. `justNow`: the admin allowed it on this page a moment ago. */
export function AllowedNote({
  until,
  justNow,
  busy,
  onWithdraw,
}: {
  until: string
  justNow: boolean
  busy: boolean
  onWithdraw: () => void
}) {
  const withdraw = (
    <Button
      size="sm"
      busy={busy}
      onClick={onWithdraw}
      title="Your agent can no longer change email and sign-in with this link"
    >
      Withdraw
    </Button>
  )
  if (!justNow)
    return (
      <div className="as-link">
        <span className="as-small">This link can also change email and sign-in until {timeOf(until)}.</span>
        {withdraw}
      </div>
    )
  return (
    <Note tone="success" title="Your agent can now set up email and sign-in" action={withdraw}>
      Until {timeOf(until)}. Your agent notices on its own and goes on; you can also tell it in the chat.
    </Note>
  )
}

/**
 * What the agent asked for and from where (setup-mcp.ts notes it on PASSKEY_NEEDED), and when the link was last used:
 * so the admin can tell it is their own agent, not someone else holding the link.
 */
export function AllowRequestDetails({ linkKey }: { linkKey: LinkKey }) {
  const { request, lastUsedAt } = linkKey
  if (!request && !lastUsedAt) return null
  return (
    <dl className="as-allow-facts">
      {request && (
        <>
          <dt>Asks to</dt>
          <dd>{request.what}</dd>
          <dt>Asked</dt>
          <dd>
            {timeOf(request.at)}
            {request.ip ? ` from ${request.ip}` : ''}
            {request.client ? ` (${request.client})` : ''}
          </dd>
        </>
      )}
      {lastUsedAt && (
        <>
          <dt>Link last used</dt>
          <dd>{timeOf(lastUsedAt)}</dd>
        </>
      )}
    </dl>
  )
}

/** The modal the Allow link opens: which link, what it may change, Allow with passkey or Cancel. */
export function AllowDialog({
  linkKey,
  allow,
  passkeyMissing,
  onClose,
}: {
  linkKey: LinkKey
  allow: Allow
  /** The admin has no passkey yet (step 1 of the page): nothing to confirm with. */
  passkeyMissing: boolean
  onClose: () => void
}) {
  const close = () => {
    if (allow.busy) return
    allow.clear()
    onClose()
  }
  return (
    <Dialog
      title="Let your agent set up email and sign-in?"
      size="sm"
      onClose={close}
      onSubmit={e => {
        e.preventDefault()
        if (!allow.busy && !passkeyMissing) void allow.allow(linkKey.id)
      }}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={allow.busy}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            busy={allow.busy}
            disabled={passkeyMissing}
            title="Confirm with your passkey (fingerprint, face or device PIN)"
          >
            {allow.busy ? 'Waiting for your passkey…' : 'Allow with passkey'}
          </Button>
        </>
      }
    >
      <div className="as-allow">
        <p>
          Your agent asks with setup link <b>{linkKey.prefix}…</b>, created {timeOf(linkKey.createdAt)}. Allow only if
          that is the link you gave your agent and you started this request.
        </p>
        <AllowRequestDetails linkKey={linkKey} />
        <p>
          It may then connect and change, for 12 hours or until the link ends: this server’s <b>email service</b>, its{' '}
          <b>sign-in and calendar apps</b> (Google, Microsoft, GitHub, single sign-on), and <b>recording storage</b> on
          this server or your private network. Whoever controls email and sign-in can sign in as anyone, so it needs
          your passkey. You can withdraw it here at any time.
        </p>
        {passkeyMissing && (
          <Note tone="warning" title="Add your passkey first">
            It is step 1 on this page. Then allow here.
          </Note>
        )}
        {allow.problem && (
          <Note tone={allow.problem.cancelled ? 'neutral' : 'danger'}>
            {allow.problem.cancelled
              ? 'The passkey prompt closed without confirming. Nothing was allowed; try again when you are ready.'
              : allow.problem.message}
          </Note>
        )}
      </div>
    </Dialog>
  )
}
