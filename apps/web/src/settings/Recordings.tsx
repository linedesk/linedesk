// Settings, Recordings: how long call recordings are kept. Older ones are deleted by a daily job on
// the server; the call itself, its transcript and summary stay.
import { recordingRetentionChoices, type WorkspaceSettingsData } from '@callfront/actions'
import { useEffect, useState } from 'react'
import { useRun } from '../store.tsx'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { Field, Section } from './fields.tsx'
import { readAction } from './settings-api.ts'

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
  const [days, setDays] = useState<number | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    readAction<WorkspaceSettingsData>('workspace.getSettings').then(
      data => setDays(data.recordingRetentionDays),
      (e: Error) => setError(e.message),
    )
  }, [])

  function change(choice: Choice) {
    const next = daysOf(choice)
    setDays(next)
    void run('workspace.updateSettings', { recordingRetentionDays: next })
    toast(
      next === null ? 'Recordings are kept until you delete the call.' : `Recordings are now kept for ${label(next)}.`,
    )
  }

  return (
    <Section
      id="st-recordings"
      title="Recordings"
      description="Calls are recorded so you can listen back. Older recordings are deleted once a day; the call, its transcript and summary stay."
    >
      {error && (
        <p className="help" role="alert">
          {error}
        </p>
      )}
      {days === undefined && !error && <p className="help">Loading…</p>}
      {days !== undefined && (
        <Field id="st-retention" label="Keep recordings for">
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
          {!canEdit && <span className="help">Only owners and admins can change this.</span>}
        </Field>
      )}
    </Section>
  )
}
