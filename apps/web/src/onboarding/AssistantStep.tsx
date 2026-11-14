// Step 2, "Meet your assistant": its name, the greeting callers hear and its voice, then a test call in the
// browser, before anything about phones. Talking is encouraged, not required: Continue is always there.
import { mainLanguageOf, otherLanguagesOf } from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { useState } from 'react'
import { ASSISTANT_NAME_MAX, staleGreetingName } from '../settings/assistantDraft.ts'
import { Field, TextArea, TextInput } from '../settings/fields.tsx'
import { useWriteAction } from '../settings/settings-api.ts'
import { TestCallButton, useTestCall } from '../settings/TestCall.tsx'
import { TestCallPanel } from '../settings/TestCallPanel.tsx'
import { VoiceSettings } from '../settings/VoiceSettings.tsx'
import { useAssistant, useRun } from '../store.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { Loading, SkeletonFields } from '../ui/LoadStates.tsx'
import { Foot, useStepKeys } from './Frame.tsx'
import { assistantChanges, type AssistantDraft, renameInGreeting } from './flow.ts'

/** `operator`: the member runs the server (a test call nobody answers says what to fix there). */
type Props = { onBack: () => void; onNext: () => void; operator?: boolean }

export function AssistantStep(p: Props) {
  const assistant = useAssistant()
  if (assistant) return <AssistantForm assistant={assistant} {...p} />
  return (
    <>
      <div className="ob-body">
        <h1>Meet your assistant.</h1>
        <Loading what="Your assistant" loading skeleton={<SkeletonFields fields={3} />} />
      </div>
      <Foot onBack={p.onBack} canContinue={false} onContinue={p.onNext} />
    </>
  )
}

function AssistantForm({ assistant, onBack, onNext, operator = false }: Props & { assistant: Assistant }) {
  const run = useRun()
  const write = useWriteAction()
  const [draft, setDraft] = useState<AssistantDraft>(() => ({
    name: assistant.name,
    greeting: assistant.greeting,
    voice: assistant.voice,
  }))
  // The test call's lines ("Maya can't take calls yet") use the name on screen, not the saved one.
  const session = useTestCall(true, { id: assistant.id, name: draft.name.trim() || assistant.name }, operator)
  const [message, setMessage] = useState<string | null>(null)
  const name = draft.name.trim()
  const changes = assistantChanges(assistant, draft)
  // The same limit as the server's (assistant.update) and Settings › Assistant.
  const nameProblem = !name
    ? 'Give your assistant a name.'
    : name.length > ASSISTANT_NAME_MAX
      ? `At most ${ASSISTANT_NAME_MAX} characters.`
      : null
  const greetingProblem = draft.greeting.trim() ? null : 'The greeting cannot be empty.'
  const problem = nameProblem ?? greetingProblem
  // The greeting still names the saved name after a rename: saving renames it there; the hint says so and offers it now.
  const stale = staleGreetingName(draft.greeting, assistant.name, draft.name)

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
        <h1>Meet {name || 'your assistant'}.</h1>
        <p className="ob-lede">This is how callers are greeted. Change anything, then talk to {name || 'it'}.</p>
        <Field id="ob-name" label="Assistant's name" error={nameProblem}>
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
          label="Greeting"
          tip="The first thing callers hear. Short works best."
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
              Still says "{stale}".
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDraft(d => ({ ...d, greeting: renameInGreeting(d.greeting, stale, name) }))}
              >
                Use {name}
              </Button>
            </span>
          )}
        </Field>
        <VoiceSettings
          assistantId={assistant.id}
          voice={draft.voice}
          onPick={voice => setDraft(d => ({ ...d, voice }))}
          canEdit
          toast={setMessage}
          language={mainLanguageOf(assistant.languages)}
          otherLanguages={otherLanguagesOf(assistant.languages)}
          assistantName={name || assistant.name}
        />
        <div className="ob-talk">
          {/* The same button and panel as Settings › Assistant; the click saves first. */}
          <TestCallButton session={session} variant="primary" onStart={() => void talk()} />
          <span className="ob2-note">
            {session.blockedReason ?? 'Use your microphone and ask what a customer would ask.'}
          </span>
        </div>
        {/* No Open in inbox here: the inbox would end onboarding before the number is connected. */}
        <TestCallPanel session={session} onOpenCall={null} onStart={() => void talk()} />
        {message && <Note tone="danger">{message}</Note>}
      </div>
      <Foot onBack={back} onContinue={next} canContinue={!problem} />
    </>
  )
}
