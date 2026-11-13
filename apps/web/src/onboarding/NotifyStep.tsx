// Step 4, "Who hears about calls?": the owner's mobile, where urgent calls are put through (a transfer contact of
// the assistant, assistant.update), and where call summaries go: email and push for this member (notifications.*).
// No texts yet. Skippable; it shows what exists (the contact it saved before, the member's notification settings).
import { type NotificationSettingsData, setsTransferNumber } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { useEffect, useRef, useState } from 'react'
import { pushBlocker, turnOnPush, useThisDevice } from '../settings/Notifications.tsx'
import { Field, TextArea } from '../settings/fields.tsx'
import { useWriteAction } from '../settings/settings-api.ts'
import { setNotificationSettings, useNotificationQuery } from '../shell/useCallNotifications.ts'
import { useMember } from '../team/members.ts'
import { useAssistant, useRun } from '../store.tsx'
import { Checkbox, Switch } from '../ui/controls.tsx'
import { Input } from '../ui/form.tsx'
import { Button } from '../ui/kit.tsx'
import { LoadProblem, SkeletonRows } from '../ui/LoadStates.tsx'
import { Foot, useStepKeys } from './Frame.tsx'
import {
  firstWhoHears,
  mobileErrorText,
  URGENT_CONTACT_ID,
  type WhoHearsDraft,
  whoHearsProblem,
  whoHearsTransfers,
} from './flow.ts'

type Props = {
  /** The member's user id: their name is how the assistant names them to callers. */
  actorId: string
  /** False while the address is unconfirmed: the server puts no calls through to a number until it is. */
  emailConfirmed: boolean
  onBack: () => void
  onNext: () => void
}

export function NotifyStep(p: Props) {
  const assistant = useAssistant()
  if (assistant) return <NotifyForm assistant={assistant} {...p} />
  return (
    <>
      <div className="ob-body">
        <h1>Who hears about calls?</h1>
        <SkeletonRows label="Loading your assistant" rows={3} />
      </div>
      <Foot onBack={p.onBack} onContinue={p.onNext} canContinue={false} onSkipStep={p.onNext} />
    </>
  )
}

function NotifyForm({ assistant, actorId, emailConfirmed, onBack, onNext }: Props & { assistant: Assistant }) {
  const write = useWriteAction()
  const run = useRun()
  const me = useMember(actorId)
  const [draft, setDraft] = useState<WhoHearsDraft>(() => firstWhoHears(assistant.transfers))
  // A problem shows once the mobile field was left or Continue was tried, never while typing the first digits.
  const [shown, setShown] = useState(false)
  /** A refusal of the last save; `mobile` when it is about the number typed. */
  const [error, setError] = useState<{ message: string; mobile: boolean } | null>(null)
  const [saving, setSaving] = useState(false)
  // While saving, Back and Esc wait; and a save that ends after the step was left (unmounted) moves nothing.
  const left = useRef(false)
  // Set again on every mount: React's development double mount runs the cleanup once in between.
  useEffect(() => {
    left.current = false
    return () => {
      left.current = true
    }
  }, [])
  const notifications = useNotificationQuery()
  const [email, setEmail] = useState<boolean | null>(null)
  const settings = notifications.data ?? null
  const emailOn = email ?? settings?.effective.email ?? true
  const problem = whoHearsProblem(draft, assistant.transfers)
  const name = assistant.name

  const set = (change: Partial<WhoHearsDraft>) => {
    setDraft(d => ({ ...d, ...change }))
    setError(null)
  }

  async function next() {
    if (saving) return
    setShown(true)
    if (problem) return
    const transfers = whoHearsTransfers(assistant.transfers, draft, me?.name ?? '')
    const contactName = transfers?.find(c => c.id === URGENT_CONTACT_ID)?.name ?? ''
    if (transfers && !emailConfirmed && setsTransferNumber({ transfers }))
      return setError({ message: mobileErrorText('Confirm your email first', contactName), mobile: false })
    if (settings && emailOn !== settings.effective.email) {
      setNotificationSettings({
        ...settings,
        own: { ...settings.own, email: emailOn },
        effective: { ...settings.effective, email: emailOn },
      })
      void run('notifications.update', { email: emailOn })
    }
    if (transfers) {
      // Run directly: a Linedesk number or an unconfirmed address is refused by the server, and the owner
      // should see that here, not later in Settings.
      setSaving(true)
      try {
        await write('assistant.update', { assistantId: assistant.id, transfers })
      } catch (e) {
        if (left.current) return
        setSaving(false)
        const raw = (e as Error).message
        const message = mobileErrorText(raw, contactName)
        return setError({ message, mobile: message !== raw })
      }
      if (left.current) return
      setSaving(false)
    }
    onNext()
  }
  const back = () => {
    if (!saving) onBack()
  }
  useStepKeys({ onEnter: () => void next(), onEscape: back })

  const shownProblem = shown ? problem : null
  const message = error?.message ?? shownProblem?.message ?? null
  const mobileInvalid = error ? error.mobile : shownProblem?.field === 'mobile' && !!draft.mobile.trim()
  return (
    <>
      <div className="ob-body">
        <h1>Who hears about calls?</h1>
        <p className="ob-lede">
          {name} sends you a summary of every call. Urgent ones can ring your mobile right away.
        </p>
        <Field id="ob-mobile" label="Your mobile number" help="Where urgent calls are put through.">
          <Input
            id="ob-mobile"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            placeholder="(503) 555-0142"
            value={draft.mobile}
            invalid={mobileInvalid}
            onChange={e => set({ mobile: e.target.value })}
            onBlur={() => draft.mobile.trim() && setShown(true)}
          />
        </Field>
        <div className="ob-urgent">
          <div className="swrow">
            <div>
              <b>Put urgent calls through to me</b>
              <span className="help">
                {draft.urgentOn
                  ? `At any hour. If you don't pick up, ${name} takes a message for you.`
                  : `${name} takes a message on every call.`}
              </span>
            </div>
            <Switch on={draft.urgentOn} onChange={on => set({ urgentOn: on })} label="Put urgent calls through to me" />
          </div>
          {draft.urgentOn && (
            <Field id="ob-urgent" label="Urgent means">
              <TextArea id="ob-urgent" value={draft.condition} onChange={v => set({ condition: v })} />
            </Field>
          )}
        </div>
        <span className="ob-label">Call summaries</span>
        {settings ? (
          <Summaries settings={settings} email={emailOn} onEmail={setEmail} />
        ) : notifications.error ? (
          <LoadProblem
            what="Your notification settings"
            message={notifications.error}
            onRetry={() => void notifications.reload()}
          />
        ) : (
          <SkeletonRows label="Loading your notification settings" rows={2} />
        )}
        {message && (
          <p className="ob-error" role="alert">
            {message}
          </p>
        )}
      </div>
      <Foot
        onBack={back}
        onContinue={() => void next()}
        canContinue={!(shown && problem)}
        busy={saving}
        onSkipStep={onNext}
      />
    </>
  )
}

/** Email for every call (saved with Continue) and push on this device (turned on at once: the browser asks). */
function Summaries({
  settings,
  email,
  onEmail,
}: {
  settings: NotificationSettingsData
  email: boolean
  onEmail: (on: boolean) => void
}) {
  const run = useRun()
  const device = useThisDevice(settings.push.devices)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const blocker = pushBlocker(settings.push.publicKey)
  async function turnOn() {
    setBusy(true)
    setNote(null)
    const result = await turnOnPush(settings, run)
    setBusy(false)
    setNote(result.note)
    if (result.id) device.setId(result.id)
  }
  return (
    <div className="ob-summaries">
      <Checkbox checked={email} onChange={onEmail}>
        Email me a summary of every call
      </Checkbox>
      {device.on ? (
        <p className="ob2-note">Push notifications are on for this device.</p>
      ) : (
        <div className="ob-talk">
          <Button size="sm" icon="phone" disabled={!!blocker || busy} onClick={() => void turnOn()}>
            {busy ? 'Turning on…' : 'Turn on notifications on this device'}
          </Button>
          <span className="ob2-note">
            {blocker ?? note ?? 'New calls, urgent ones first, even when the app is closed.'}
          </span>
        </div>
      )}
    </div>
  )
}
