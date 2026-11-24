// Step 4, "Urgent calls": what happens when a caller has an urgent matter: put through to the owner's mobile (a transfer
// contact of the assistant, assistant.update) or a message with an alert right away. Where call summaries go is not asked
// here: the defaults hold (email on), the rest is in User settings › Preferences. A first visit starts at the
// message (it needs no number), and only "put through" asks for a number. No texts yet. Can be done later; it shows what exists (the
// contact it saved before, the member's notification settings). Continue never waits for the server: the saves are
// queued, and a refusal comes back as the onboarding's save error for this step (Onboarding.tsx).
import { setsTransferNumber } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { brandName } from '../brand.ts'
import { useDefaultPhoneCountry } from '../phoneCountry.ts'
import { Field, TextArea } from '../settings/fields.tsx'
import { useAssistantOf, useRows, useRun } from '../store.tsx'
import { useMember } from '../team/members.ts'
import { RadioCard } from '../ui/controls.tsx'
import { Note } from '../ui/kit.tsx'
import { PhoneInput } from '../ui/PhoneInput.tsx'
import { useWorkspaceCountry } from '../workspaceLocale.ts'
import { useClientWord, useForClient } from './clientWords.tsx'
import { Foot, StepLoading } from './Frame.tsx'
import {
  EMERGENCY_NOTE,
  firstWhoHears,
  outboundE164,
  type UrgentChoice,
  urgentCasesFrom,
  type WhoHearsDraft,
  whoHearsProblem,
  whoHearsTransfers,
} from './flow.ts'
import { useOutboundCountries, withUnfinishedNumber } from './outbound-number.ts'
import { useSetupKeys } from './setup-keys.ts'

type Props = {
  /** The member's user id: their name is how the assistant names them to callers. */
  actorId: string
  /** False while the address is unconfirmed: the server puts no calls through to a number until it is. */
  emailConfirmed: boolean
  onBack: () => void
  onNext: () => void
  /** The assistant whose calls these are (step by step from its settings); else the workspace's default one. */
  assistantId?: string
}

export function NotifyStep(p: Props) {
  const t = useT()
  const assistant = useAssistantOf(p.assistantId)
  if (assistant) return <NotifyForm assistant={assistant} {...p} />
  return (
    <StepLoading
      title={t('onboarding.notify.title')}
      what={t('onboarding.notify.loadingAssistant')}
      foot={{ onBack: p.onBack, onContinue: p.onNext, onSkipStep: p.onNext, laterTitle: t(LATER) }}
    />
  )
}

const LATER = msg('onboarding.notify.later')

function NotifyForm({ assistant, actorId, emailConfirmed, onBack, onNext }: Props & { assistant: Assistant }) {
  const t = useT()
  const word = useClientWord()
  // A partner's team: urgent calls go to the client's mobile, so the contact is named for the owner, not this member.
  const forClient = useForClient()
  const run = useRun()
  const me = useMember(actorId)
  const numbers = useRows('phone_numbers')
  const workspaceCountry = useWorkspaceCountry()
  // "Urgent means" starts from the urgent cases the business step's common calls already name.
  const [draft, setDraft] = useState<WhoHearsDraft>(() =>
    firstWhoHears(assistant.transfers, urgentCasesFrom(assistant.business_profile.instructions)),
  )
  // A problem shows once the mobile field was left or Continue was tried, never while typing the first digits or
  // before the owner had a chance to choose.
  const [shown, setShown] = useState(false)
  /** What the step itself can tell before saving; `mobile` when it is about the number typed. */
  const [error, setError] = useState<{ message: string; mobile: boolean } | null>(null)
  const countries = useOutboundCountries()
  const phoneCountry = useDefaultPhoneCountry()
  const problem = withUnfinishedNumber(draft, whoHearsProblem(draft, assistant.transfers, countries))
  const name = assistant.name

  const set = (change: Partial<WhoHearsDraft>) => {
    setDraft(d => ({ ...d, ...change }))
    setError(null)
  }

  function next() {
    setShown(true)
    if (problem) return
    const transfers = whoHearsTransfers(assistant.transfers, draft, forClient ? '' : (me?.name ?? ''))
    if (transfers && !emailConfirmed && setsTransferNumber({ transfers }))
      return setError({ message: t('onboarding.flow.mobileError.confirmEmail'), mobile: false })
    // The server refuses a number of this workspace too; said here at once, without a round trip.
    const typed = draft.urgent === 'transfer' ? outboundE164(draft.mobile) : null
    if (typed && numbers.some(n => n.e164 === typed))
      return setError({ message: t('onboarding.notify.ownNumber', { brand: brandName() }), mobile: true })
    // Queued, not awaited: a refusal (a number forwarding to us, say) comes back as this step's save error.
    if (transfers) void run('assistant.update', { assistantId: assistant.id, transfers })
    onNext()
  }
  useSetupKeys({ onEnter: next, onEscape: onBack })

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
        <h1 id="ob-urgent">{t('onboarding.notify.title')}</h1>
        <p className="ob-lede">{t(word('onboarding.notify.lede'), { name })}</p>
        <div className="k-radios ob-choices" role="radiogroup" aria-labelledby="ob-urgent">
          {/* The default first (it needs no number), as on the pick-up step. */}
          <RadioCard
            name="ob-urgent"
            checked={draft.urgent === 'message'}
            onPick={() => pick('message')}
            title={t(word('onboarding.notify.message.title'))}
            description={t(word('onboarding.notify.message.description'), { name })}
          />
          <RadioCard
            name="ob-urgent"
            checked={draft.urgent === 'transfer'}
            onPick={() => pick('transfer')}
            title={t(word('onboarding.notify.transfer.title'))}
            description={t(word('onboarding.notify.transfer.description'), { name })}
          />
        </div>
        {draft.urgent === 'transfer' && (
          <div className="ob-urgent">
            <Field
              id="ob-mobile"
              label={t(word('onboarding.notify.mobile.label'))}
              tip={t('onboarding.notify.mobile.tip')}
              error={mobileError}
            >
              <PhoneInput
                id="ob-mobile"
                defaultCountry={phoneCountry}
                value={draft.mobile}
                invalid={mobileInvalid}
                onChange={mobile => set({ mobile })}
                onBlur={() => draft.mobile.trim() && setShown(true)}
              />
            </Field>
            <Field
              id="ob-urgent-means"
              label={t('onboarding.notify.urgentMeans')}
              help={EMERGENCY_NOTE(name, workspaceCountry?.country)}
              error={conditionError}
            >
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
        laterTitle={t(LATER)}
      />
    </>
  )
}
