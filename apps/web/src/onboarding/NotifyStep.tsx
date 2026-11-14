// Step 4, "Who hears about calls?": first where call summaries go (email and push for this member,
// notifications.*), then what happens when a caller has an urgent matter: put through to the owner's mobile (a transfer
// contact of the assistant, assistant.update) or a message with an alert right away. Nothing is preselected for
// urgent matters, and only "put through" asks for a number. No texts yet. Can be done later; it shows what exists (the
// contact it saved before, the member's notification settings). Continue never waits for the server: the saves are
// queued, and a refusal comes back as the onboarding's save error for this step (Onboarding.tsx).
import { type NotificationSettingsData, setsTransferNumber } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { useState } from 'react'
import { brandName } from '../brand.ts'
import { Field, TextArea } from '../settings/fields.tsx'
import { useDeviceNotifications } from '../settings/Notifications.tsx'
import { setNotificationSettings, useNotificationQuery } from '../shell/useCallNotifications.ts'
import { useAssistant, useRows, useRun } from '../store.tsx'
import { useMember } from '../team/members.ts'
import { Checkbox, RadioCard } from '../ui/controls.tsx'
import { Input } from '../ui/form.tsx'
import { Note } from '../ui/kit.tsx'
import { Loading, Skeleton, SkeletonFields } from '../ui/LoadStates.tsx'
import { Foot, useStepKeys } from './Frame.tsx'
import {
  EMERGENCY_NOTE,
  firstWhoHears,
  mobileErrorText,
  toE164,
  URGENT_CONTACT_ID,
  type UrgentChoice,
  urgentCasesFrom,
  type WhoHearsDraft,
  whoHearsProblem,
  whoHearsTransfers,
} from './flow.ts'

type Props = {
  /** The member's user id: their name is how the assistant names them to callers. */
  actorId: string
  /** False while the address is unconfirmed: the server puts no calls through to a number until it is. */
  emailConfirmed: boolean
  /** An instance admin: what the server lacks links to Admin › Providers; everyone else is told whom to ask. */
  admin: boolean
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
        <Loading what="Your assistant" loading skeleton={<SkeletonFields fields={3} />} />
      </div>
      <Foot onBack={p.onBack} onContinue={p.onNext} canContinue={false} onSkipStep={p.onNext} laterTitle={LATER} />
    </>
  )
}

const LATER = 'Set this up later in Settings › Notifications and Settings › Assistant'

function NotifyForm({ assistant, actorId, emailConfirmed, admin, onBack, onNext }: Props & { assistant: Assistant }) {
  const run = useRun()
  const me = useMember(actorId)
  const numbers = useRows('phone_numbers')
  // "Urgent means" starts from the urgent cases the business step's common calls already name.
  const [draft, setDraft] = useState<WhoHearsDraft>(() =>
    firstWhoHears(assistant.transfers, urgentCasesFrom(assistant.business_profile.instructions)),
  )
  // A problem shows once the mobile field was left or Continue was tried, never while typing the first digits or
  // before the owner had a chance to choose.
  const [shown, setShown] = useState(false)
  /** What the step itself can tell before saving; `mobile` when it is about the number typed. */
  const [error, setError] = useState<{ message: string; mobile: boolean } | null>(null)
  const notifications = useNotificationQuery()
  const [email, setEmail] = useState<boolean | null>(null)
  const settings = notifications.data ?? null
  const emailOn = email ?? settings?.effective.email ?? true
  const problem = whoHearsProblem(draft, assistant.transfers)
  // "Take a message and alert me" alerts by email or push; with both off nobody hears of an urgent call until they look.
  // Email that this server cannot send alerts nobody either.
  const emailWorks = emailOn && settings?.emailReady !== false
  const nobodyAlerted = draft.urgent === 'message' && !!settings && !emailWorks && settings.push.devices.length === 0
  const name = assistant.name

  const set = (change: Partial<WhoHearsDraft>) => {
    setDraft(d => ({ ...d, ...change }))
    setError(null)
  }

  function next() {
    setShown(true)
    if (problem) return
    const transfers = whoHearsTransfers(assistant.transfers, draft, me?.name ?? '')
    const contactName = transfers?.find(c => c.id === URGENT_CONTACT_ID)?.name ?? ''
    if (transfers && !emailConfirmed && setsTransferNumber({ transfers }))
      return setError({ message: mobileErrorText('Confirm your email first', contactName), mobile: false })
    // The server refuses a number of this workspace too; said here at once, without a round trip.
    const typed = draft.urgent === 'transfer' ? toE164(draft.mobile) : null
    if (typed && numbers.some(n => n.e164 === typed))
      return setError({ message: `That is a ${brandName()} number. Enter your own mobile.`, mobile: true })
    if (settings && emailOn !== settings.effective.email) {
      setNotificationSettings({
        ...settings,
        own: { ...settings.own, email: emailOn },
        effective: { ...settings.effective, email: emailOn },
      })
      void run('notifications.update', { email: emailOn })
    }
    // Queued, not awaited: a refusal (a number forwarding to us, say) comes back as this step's save error.
    if (transfers) void run('assistant.update', { assistantId: assistant.id, transfers })
    onNext()
  }
  useStepKeys({ onEnter: next, onEscape: onBack })

  const shownProblem = shown ? problem : null
  const message = error?.message ?? shownProblem?.message ?? null
  const mobileInvalid = error ? error.mobile : shownProblem?.field === 'mobile' && !!draft.mobile.trim()
  // Field errors show under their field; the rest (no choice, a full list, confirm your email) under the choices.
  const at =
    draft.urgent !== 'transfer' ? null : error ? (error.mobile ? 'mobile' : null) : (shownProblem?.field ?? null)
  const mobileError = at === 'mobile' ? message : null
  const conditionError = at === 'condition' ? message : null
  const otherMessage = at === 'mobile' || at === 'condition' ? null : message
  const pick = (urgent: UrgentChoice) => {
    // A new choice starts without the old complaint; a mobile problem shows again once the field is left.
    if (urgent !== draft.urgent) setShown(false)
    set({ urgent })
  }
  return (
    <>
      <div className="ob-body">
        <h1>Who hears about calls?</h1>
        <p className="ob-lede">{name} answers, then tells you what each call was about.</p>
        <span className="ob-label" id="ob-hear">
          How do you want to hear about calls?
        </span>
        <Loading
          what="Your notification settings"
          loading={!settings}
          error={notifications.error}
          onRetry={() => void notifications.reload()}
          skeleton={
            <div className="ob-summaries">
              <Skeleton shape="text" width={240} />
              <Skeleton shape="text" width={280} />
            </div>
          }
        >
          {settings && <Summaries settings={settings} email={emailOn} onEmail={setEmail} admin={admin} />}
        </Loading>
        <span className="ob-label" id="ob-urgent">
          If a call is urgent
        </span>
        <div className="k-radios ob-choices" role="radiogroup" aria-labelledby="ob-urgent">
          <RadioCard
            name="ob-urgent"
            checked={draft.urgent === 'transfer'}
            onPick={() => pick('transfer')}
            title="Put them through to my mobile"
            description={`At any hour. If you don't pick up, ${name} takes a message.`}
          />
          <RadioCard
            name="ob-urgent"
            checked={draft.urgent === 'message'}
            onPick={() => pick('message')}
            title="Take a message and alert me right away"
            description="No number needed."
          />
        </div>
        {nobodyAlerted && (
          <Note tone="warning">
            {emailOn
              ? 'Without email on this server and with notifications off, nobody is alerted. Turn on notifications above.'
              : 'With email and notifications off, nobody is alerted. Turn on one of them above.'}
          </Note>
        )}
        {draft.urgent === 'transfer' && (
          <div className="ob-urgent">
            <Field
              id="ob-mobile"
              label="Your mobile number"
              tip="Where urgent calls, and callers who ask for a person, are put through."
              error={mobileError}
            >
              <Input
                id="ob-mobile"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="Your mobile number"
                value={draft.mobile}
                invalid={mobileInvalid}
                onChange={e => set({ mobile: e.target.value })}
                onBlur={() => draft.mobile.trim() && setShown(true)}
              />
            </Field>
            <Field id="ob-urgent-means" label="Urgent means" help={EMERGENCY_NOTE(name)} error={conditionError}>
              <TextArea
                id="ob-urgent-means"
                value={draft.condition}
                onChange={v => set({ condition: v })}
                invalid={!!conditionError}
              />
            </Field>
          </div>
        )}
        {otherMessage && <Note tone="danger">{otherMessage}</Note>}
      </div>
      <Foot
        onBack={onBack}
        onContinue={next}
        canContinue={!(shown && problem)}
        onSkipStep={onNext}
        laterTitle={LATER}
      />
    </>
  )
}

/**
 * Email for every call (saved with Continue) and notifications on this device (at once), the same switch as Settings ›
 * Notifications: turning it on asks the browser for permission.
 */
function Summaries({
  settings,
  email,
  onEmail,
  admin,
}: {
  settings: NotificationSettingsData
  email: boolean
  onEmail: (on: boolean) => void
  admin: boolean
}) {
  const device = useDeviceNotifications(settings)
  return (
    <div className="ob-summaries">
      <Checkbox checked={email} onChange={onEmail}>
        Email me a summary of every call
      </Checkbox>
      {/* The choice is kept either way; it says that nothing arrives until the server sends email. */}
      {settings.emailReady === false && (
        <p className="ob2-note" role="status">
          Email isn't set up on this server yet.{' '}
          {admin ? (
            <a className="k-link" href="#admin/providers/email">
              Set it up in Admin › Providers
            </a>
          ) : (
            'Ask whoever runs this server.'
          )}
        </p>
      )}
      <Checkbox checked={device.on} onChange={on => void device.set(on)} disabled={device.disabled}>
        Notifications on this device
      </Checkbox>
      <p className="ob2-note ob-push-note">{device.note}</p>
    </div>
  )
}
