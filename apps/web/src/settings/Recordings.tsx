// Settings, Recordings: how long call recordings are kept, and the notice the assistant says after the
// greeting. Older recordings are deleted by a daily job on the server; the call itself, its transcript
// and summary stay.
import { RECORDING_NOTICE_MAX, recordingRetentionChoices } from '@linedesk/actions'
import { useState } from 'react'
import { useRun } from '../store.tsx'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { Button } from '../ui/kit.tsx'
import { LoadProblem, Skeleton } from '../ui/LoadStates.tsx'
import { Field, Section, SwitchRow, TextInput } from './fields.tsx'
import { patchWorkspaceSettings, useWorkspaceSettings } from './settings-api.ts'

type Days = (typeof recordingRetentionChoices)[number]
type Choice = `${Days}` | 'forever'

const label = (days: number) => (days === 365 ? '1 year' : `${days} days`)
const options: SelectOption<Choice>[] = [
  ...recordingRetentionChoices.map(days => ({ value: `${days}` as Choice, label: label(days) })),
  { value: 'forever', label: 'Keep forever' },
]
const choiceOf = (days: number | null): Choice => (days === null ? 'forever' : (`${days}` as Choice))
const daysOf = (choice: Choice): Days | null => (choice === 'forever' ? null : (Number(choice) as Days))

export function Recordings({ canEdit, toast }: { canEdit: boolean; toast: (text: string) => void }) {
  const run = useRun()
  const settings = useWorkspaceSettings()
  const days = settings.data?.recordingRetentionDays
  const recordingOn = settings.data?.recordingOn ?? true
  const error = settings.data ? null : settings.error

  function change(choice: Choice) {
    const next = daysOf(choice)
    patchWorkspaceSettings({ recordingRetentionDays: next })
    void run('workspace.updateSettings', { recordingRetentionDays: next })
    toast(next === null ? 'Recordings are kept until you delete the call.' : `Recordings are kept for ${label(next)}.`)
  }

  return (
    <Section
      id="st-recordings"
      title="Recordings"
      description={recordingOn ? undefined : 'Recording is off on this server.'}
      help={
        recordingOn
          ? 'Recordings older than this are deleted automatically. Only the audio goes; the call, its transcript and summary stay.'
          : 'Calls are not recorded. Whoever runs your Linedesk server can turn recording on.'
      }
    >
      {error && <LoadProblem what="Recording settings" message={error} onRetry={() => void settings.reload()} />}
      {days === undefined && !error && <Skeleton className="sk-field" />}
      {days !== undefined && (
        <Field
          id="st-retention"
          label="Keep recordings for"
          help={canEdit ? undefined : 'Only owners and admins can change this.'}
        >
          <div>
            <Select
              id="st-retention"
              value={choiceOf(days)}
              options={options}
              onChange={change}
              label="Keep recordings for"
              disabled={!canEdit}
            />
          </div>
        </Field>
      )}
      {settings.data && (
        <RecordingNotice
          on={settings.data.recordingNoticeOn}
          saved={settings.data.recordingNotice}
          canEdit={canEdit}
          toast={toast}
        />
      )}
    </Section>
  )
}

type NoticeProps = { on: boolean; saved: string; canEdit: boolean; toast: (text: string) => void }

/** The switch and the sentence the assistant says right after the greeting. */
function RecordingNotice({ on, saved, canEdit, toast }: NoticeProps) {
  const run = useRun()
  const [draft, setDraft] = useState(saved)
  const text = draft.trim()
  const problem = !text
    ? 'Write the sentence the assistant says.'
    : text.length > RECORDING_NOTICE_MAX
      ? `Keep it under ${RECORDING_NOTICE_MAX} characters.`
      : null

  function toggle(next: boolean) {
    patchWorkspaceSettings({ recordingNoticeOn: next })
    void run('workspace.updateSettings', { recordingNoticeOn: next })
    toast(next ? 'The assistant says the notice after the greeting.' : 'The assistant no longer says the notice.')
  }

  function save() {
    if (problem || text === saved) return
    setDraft(text)
    patchWorkspaceSettings({ recordingNotice: text })
    void run('workspace.updateSettings', { recordingNotice: text })
    toast('Notice saved.')
  }

  return (
    <>
      <SwitchRow
        title="Say that the call may be recorded"
        description="Right after the greeting."
        on={on}
        onChange={toggle}
        disabled={!canEdit}
      />
      {on && (
        <Field id="st-notice" label="What the assistant says" error={problem}>
          <form
            className="st-notice"
            onSubmit={e => {
              e.preventDefault()
              save()
            }}
          >
            <TextInput
              id="st-notice"
              value={draft}
              onChange={setDraft}
              label="What the assistant says"
              invalid={Boolean(problem)}
            />
            {canEdit && text !== saved && (
              <Button type="submit" size="sm" variant="primary" title="Save the notice" disabled={Boolean(problem)}>
                Save
              </Button>
            )}
          </form>
        </Field>
      )}
    </>
  )
}
