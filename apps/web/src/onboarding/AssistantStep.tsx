// Step 2, "Meet your assistant": its name, the greeting callers hear and its voice (not with the realtime model: that
// speaks in the server's voice), then a test call in the browser, before anything about phones. Talking is encouraged, not required: Continue is always there.
import { localizedDefault, mainLanguageOf, otherLanguagesOf, pipelineFor } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { ASSISTANT_NAME_MAX, staleGreetingName } from '../settings/assistantDraft.ts'
import { Field, TextArea, TextInput } from '../settings/fields.tsx'
import { useWriteAction } from '../settings/settings-api.ts'
import { TestCallButton, useTestCall } from '../settings/TestCall.tsx'
import { TestCallPanel } from '../settings/TestCallPanel.tsx'
import { useVoiceOptions, VoiceSettings } from '../settings/VoiceSettings.tsx'
import { useAssistant, useRun } from '../store.tsx'
import { useWorkspaceLanguage } from '../workspaceLocale.ts'
import { Button, Note } from '../ui/kit.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { Foot, useStepKeys } from './Frame.tsx'
import { assistantChanges, type AssistantDraft, renameInGreeting } from './flow.ts'

/** `operator`: the member runs the server (a test call nobody answers says what to fix there). */
type Props = { onBack: () => void; onNext: () => void; operator?: boolean }

export function AssistantStep(p: Props) {
  const t = useT()
  const assistant = useAssistant()
  if (assistant) return <AssistantForm assistant={assistant} {...p} />
  return (
    <>
      <div className="ob-body">
        <h1>{t('onboarding.assistant.heading')}</h1>
        <Loading what={t('onboarding.assistant.loadingWhat')} loading skeleton={<SkeletonFields fields={3} />} />
      </div>
      <Foot onBack={p.onBack} canContinue={false} onContinue={p.onNext} />
    </>
  )
}

function AssistantForm({ assistant, onBack, onNext, operator = false }: Props & { assistant: Assistant }) {
  const t = useT()
  const run = useRun()
  const write = useWriteAction()
  // Without a main language of its own the assistant greets in the workspace language: the default greeting shows in it.
  const workspaceLanguage = useWorkspaceLanguage()
  const main = mainLanguageOf(assistant.languages, workspaceLanguage)
  const [draft, setDraft] = useState<AssistantDraft>(() => ({
    name: assistant.name,
    greeting: assistant.languages?.main ? assistant.greeting : localizedDefault(assistant.greeting, main),
    voice: assistant.voice,
  }))
  // The test call's lines ("Maya can't take calls yet") use the name on screen, not the saved one.
  const session = useTestCall(true, { id: assistant.id, name: draft.name.trim() || assistant.name }, operator)
  const [message, setMessage] = useState<string | null>(null)
  const name = draft.name.trim()
  const changes = assistantChanges(assistant, draft)
  // The same limit as the server's (assistant.update) and Assistant settings.
  const nameProblem = !name
    ? t('onboarding.assistant.nameRequired')
    : name.length > ASSISTANT_NAME_MAX
      ? t('onboarding.assistant.nameTooLong', { max: ASSISTANT_NAME_MAX })
      : null
  const greetingProblem = draft.greeting.trim() ? null : t('onboarding.assistant.greetingEmpty')
  const problem = nameProblem ?? greetingProblem
  // The greeting still names the saved name after a rename: saving renames it there; the hint says so and offers it now.
  const stale = staleGreetingName(draft.greeting, assistant.name, draft.name)
  // Like Assistant settings: the realtime model speaks in the voice set for the server, so no voice picker then. An API
  // of an older version (during an update) only says whether a realtime model is connected.
  const voiceOptions = useVoiceOptions().data
  const realtime = voiceOptions?.pipelines
    ? pipelineFor(assistant.voice_pipeline, voiceOptions.pipelines) === 'realtime'
    : voiceOptions?.realtime === true

  function next() {
    if (problem) return
    if (changes) void run('assistant.update', { assistantId: assistant.id, ...changes })
    onNext()
  }
  // Back keeps what was typed: a valid draft is saved like Continue (queued), so a rename is not lost.
  function back() {
    if (!problem && changes) void run('assistant.update', { assistantId: assistant.id, ...changes })
    onBack()
  }
  // The call must hear what is on screen: unsaved changes are saved first (directly, not through the outbox).
  async function talk() {
    if (problem) return setMessage(problem)
    setMessage(null)
    try {
      if (changes) await write('assistant.update', { assistantId: assistant.id, ...changes })
      session.start()
    } catch (e) {
      setMessage((e as Error).message)
    }
  }
  useStepKeys({ onEnter: next, onEscape: back })

  return (
    <>
      <div className="ob-body">
        <h1>{name ? t('onboarding.assistant.headingNamed', { name }) : t('onboarding.assistant.heading')}</h1>
        <p className="ob-lede">
          {name ? t('onboarding.assistant.lede', { name }) : t('onboarding.assistant.ledeUnnamed')}
        </p>
        <Field id="ob-name" label={t('onboarding.assistant.nameLabel')} error={nameProblem}>
          <TextInput
            id="ob-name"
            value={draft.name}
            onChange={v => setDraft(d => ({ ...d, name: v }))}
            placeholder="Maya"
            invalid={!!nameProblem}
          />
        </Field>
        <Field
          id="ob-greeting"
          label={t('onboarding.assistant.greetingLabel')}
          tip={t('onboarding.assistant.greetingTip')}
          error={greetingProblem}
        >
          <TextArea
            id="ob-greeting"
            value={draft.greeting}
            onChange={v => setDraft(d => ({ ...d, greeting: v }))}
            invalid={!!greetingProblem}
          />
          {stale && (
            <span className="help as-stale">
              {t('onboarding.assistant.staleGreeting', { name: stale })}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraft(d => ({ ...d, greeting: renameInGreeting(d.greeting, stale, name) }))}
              >
                {t('onboarding.assistant.useName', { name })}
              </Button>
            </span>
          )}
        </Field>
        {realtime ? (
          <p className="ob2-note">{t('onboarding.assistant.voiceServer')}</p>
        ) : (
          <VoiceSettings
            assistantId={assistant.id}
            voice={draft.voice}
            onPick={voice => setDraft(d => ({ ...d, voice }))}
            canEdit
            toast={setMessage}
            language={main}
            otherLanguages={otherLanguagesOf(assistant.languages, workspaceLanguage)}
            assistantName={name || assistant.name}
          />
        )}
        <div className="ob-talk">
          {/* The same button and panel as Assistant settings; the click saves first. */}
          <TestCallButton session={session} variant="primary" onStart={() => void talk()} />
          <span className="ob2-note">{session.blockedReason ?? t('onboarding.assistant.talkHint')}</span>
        </div>
        {/* No Open in inbox here: the inbox would end onboarding before the number is connected. */}
        <TestCallPanel session={session} onOpenCall={null} onStart={() => void talk()} />
        {message && <Note tone="danger">{message}</Note>}
      </div>
      <Foot onBack={back} onContinue={next} canContinue={!problem} />
    </>
  )
}
