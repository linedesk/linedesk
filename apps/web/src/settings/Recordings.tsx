// Settings, Recordings: how long call recordings are kept, and the notice the assistant says after the
// greeting. Older recordings are deleted by a daily job on the server; the call itself, its transcript
// and summary stay.
import { onlyAdmins } from './readOnly.ts'
import { RECORDING_NOTICE_MAX, RECORDINGS_NOT_KEPT, recordingRetentionChoices } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { useRun } from '../store.tsx'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { Button } from '../ui/kit.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { Field, Section, SkeletonSwitchRows, SwitchRow, TextInput } from './fields.tsx'
import { patchWorkspaceSettings, useWorkspaceSettings } from './settings-api.ts'

type Days = (typeof recordingRetentionChoices)[number]
type Choice = `${Days}` | 'forever'

/** The retention choices, in the active language. */
function retentionOptions(t: ReturnType<typeof useT>): SelectOption<Choice>[] {
  return [
    ...recordingRetentionChoices.map(days => ({
      value: `${days}` as Choice,
      label:
        days === RECORDINGS_NOT_KEPT
          ? t('settings.recordings.dontKeep')
          : days === 365
            ? t('settings.recordings.oneYear')
            : t('settings.recordings.days', { days }),
    })),
    { value: 'forever', label: t('settings.recordings.forever') },
  ]
}
const choiceOf = (days: number | null): Choice => (days === null ? 'forever' : (`${days}` as Choice))
const daysOf = (choice: Choice): Days | null => (choice === 'forever' ? null : (Number(choice) as Days))

export function Recordings({ canEdit, toast }: { canEdit: boolean; toast: (text: string) => void }) {
  const t = useT()
  const run = useRun()
  const settings = useWorkspaceSettings()
  const days = settings.data?.recordingRetentionDays
  const recordingOn = settings.data?.recordingOn ?? true
  const error = settings.data ? null : settings.error

  function change(choice: Choice) {
    const next = daysOf(choice)
    patchWorkspaceSettings({ recordingRetentionDays: next })
    void run('workspace.updateSettings', { recordingRetentionDays: next })
    toast(
      next === null
        ? t('settings.recordings.keptForever')
        : next === RECORDINGS_NOT_KEPT
          ? t('settings.recordings.notRecorded')
          : next === 365
            ? t('settings.recordings.keptOneYear')
            : t('settings.recordings.keptDays', { days: next }),
    )
  }

  return (
    <Section
      id="st-recordings"
      title={t('settings.recordings.title')}
      description={recordingOn ? undefined : t('settings.recordings.offOnServer')}
      help={recordingOn ? t('settings.recordings.help') : t('settings.recordings.helpOff')}
    >
      <Loading
        what={t('settings.recordings.loadWhat')}
        loading={days === undefined}
        error={error}
        onRetry={() => void settings.reload()}
        skeleton={
          <>
            <Field label={t('settings.recordings.keepFor')}>
              <Skeleton shape="field" width={260} />
            </Field>
            <SkeletonSwitchRows rows={1} />
          </>
        }
      >
        {days !== undefined && (
          <Field id="st-retention" label={t('settings.recordings.keepFor')} help={canEdit ? undefined : onlyAdmins()}>
            <div>
              <Select
                id="st-retention"
                value={choiceOf(days)}
                options={retentionOptions(t)}
                onChange={change}
                label={t('settings.recordings.keepFor')}
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
      </Loading>
    </Section>
  )
}

type NoticeProps = { on: boolean; saved: string; canEdit: boolean; toast: (text: string) => void }

/** The switch and the sentence the assistant says right after the greeting. */
function RecordingNotice({ on, saved, canEdit, toast }: NoticeProps) {
  const t = useT()
  const run = useRun()
  const [draft, setDraft] = useState(saved)
  const text = draft.trim()
  const problem = !text
    ? t('settings.recordings.noticeEmpty')
    : text.length > RECORDING_NOTICE_MAX
      ? t('settings.recordings.noticeTooLong', { max: RECORDING_NOTICE_MAX })
      : null

  function toggle(next: boolean) {
    patchWorkspaceSettings({ recordingNoticeOn: next })
    void run('workspace.updateSettings', { recordingNoticeOn: next })
    toast(next ? t('settings.recordings.noticeOn') : t('settings.recordings.noticeOff'))
  }

  function save() {
    if (problem || text === saved) return
    setDraft(text)
    patchWorkspaceSettings({ recordingNotice: text })
    void run('workspace.updateSettings', { recordingNotice: text })
    toast(t('settings.recordings.noticeSaved'))
  }

  return (
    <>
      <SwitchRow
        title={t('settings.recordings.noticeSwitch')}
        description={t('settings.recordings.noticeSwitchHelp')}
        on={on}
        onChange={toggle}
        disabled={!canEdit}
      />
      {on && (
        <Field id="st-notice" label={t('settings.recordings.noticeLabel')} error={problem}>
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
              label={t('settings.recordings.noticeLabel')}
              invalid={Boolean(problem)}
            />
            {canEdit && text !== saved && (
              <Button
                type="submit"
                size="sm"
                variant="primary"
                title={t('settings.recordings.noticeSaveTip')}
                disabled={Boolean(problem)}
              >
                {t('common.action.save')}
              </Button>
            )}
          </form>
        </Field>
      )}
    </>
  )
}
