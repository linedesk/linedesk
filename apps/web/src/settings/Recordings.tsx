// Settings, Recordings: how long call recordings are kept. Older ones are deleted by a daily job on
// the server; the call itself, its transcript and summary stay.
import { recordingRetentionChoices } from '@linedesk/actions'
import { useRun } from '../store.tsx'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { LoadProblem, Skeleton } from '../ui/LoadStates.tsx'
import { Field, Section } from './fields.tsx'
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
      description={recordingOn ? 'Calls are recorded so you can listen back.' : 'Recording is off on this server.'}
      help={
        recordingOn
          ? 'Older recordings are deleted once a day. The call, its transcript and summary stay.'
          : 'Whoever runs your Linedesk can turn it on. This setting then applies.'
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
    </Section>
  )
}
