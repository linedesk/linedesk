// Settings, Recordings: how long call recordings are kept, and the notice the assistant says after the
// greeting. Older recordings are deleted by a daily job on the server; the call itself, its transcript
// and summary stay. With recording off on the server (no recording store) both stay as saved but greyed out: nothing
// is recorded and the assistant does not say the notice, until recording is turned on. Below it, a caller privacy notice
// template the business can copy (callerPrivacyNotice.ts).
import { useReadOnlyNote } from './readOnly.ts'
import { inEeaOrUk, RECORDING_NOTICE_MAX, RECORDINGS_NOT_KEPT, recordingRetentionChoices } from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import { appLink } from '../ui/AppLink.tsx'
import { useState } from 'react'
import { providerAudience } from '../providerAudience.ts'
import { useRun } from '../store.tsx'
import { Select, type SelectOption } from '../ui/controls.tsx'
import { Dialog } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { Field, Section, SkeletonSwitchRows, SwitchRow, TextInput } from './fields.tsx'
import { patchWorkspaceSettings, useWorkspaceSettings } from './settings-api.ts'
import { brandName } from '../brand.ts'
import { callerPrivacyNotice, type NoticeRecording } from './callerPrivacyNotice.ts'

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

/**
 * Recording is off on this server: what turns it on. Server admins get the place (Server admin › Providers, Recording
 * storage); everyone else is told to ask (providerAudience.ts, as in MissingProviderNote).
 */
export function RecordingOffNote() {
  const t = useT()
  return (
    <Note tone="warning" title={t('settings.recordings.offOnServer')}>
      {providerAudience() === 'admin' ? (
        <T
          k="settings.recordings.offAdmin"
          values={{
            link: appLink('#admin/providers/recording'),
          }}
        />
      ) : (
        t('settings.recordings.offAsk')
      )}
    </Note>
  )
}

/** A retention longer than this (or forever) gets the hint to keep recordings only as long as they are needed. */
const LONG_RETENTION_DAYS = 90

export function Recordings({ canEdit, toast }: { canEdit: boolean; toast: (text: string) => void }) {
  const t = useT()
  const readOnly = useReadOnlyNote()
  const run = useRun()
  const settings = useWorkspaceSettings()
  const days = settings.data?.recordingRetentionDays
  const recordingOn = settings.data?.recordingOn ?? true
  const error = settings.data ? null : settings.error
  // Recording off on the server: the saved choices are shown but cannot change, they apply once it is on.
  const editable = canEdit && recordingOn
  // The law hints (legal review 2026-11-17, A4, A5): only warnings, the owner decides. By the workspace's country.
  const eu = inEeaOrUk(settings.data?.resolvedCountry)
  const recorded = recordingOn && days !== undefined && days !== RECORDINGS_NOT_KEPT
  const lawHints = [
    recorded && eu ? t('settings.recordings.lawConsentEu') : null,
    recorded && (days === null || days > LONG_RETENTION_DAYS) ? t('settings.recordings.lawLongRetention') : null,
  ].filter(Boolean)

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
    <>
      <Section
        id="st-recordings"
        title={t('settings.recordings.title')}
        help={recordingOn ? t('settings.recordings.help') : t('settings.recordings.helpOff')}
      >
        {settings.data && !recordingOn && <RecordingOffNote />}
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
            <Field
              id="st-retention"
              label={t('settings.recordings.keepFor')}
              help={canEdit || !recordingOn ? lawHints.join(' ') || undefined : readOnly}
            >
              <div>
                <Select
                  id="st-retention"
                  value={choiceOf(days)}
                  options={retentionOptions(t)}
                  onChange={change}
                  label={t('settings.recordings.keepFor')}
                  disabled={!editable}
                />
              </div>
            </Field>
          )}
          {settings.data && (
            <RecordingNotice
              on={settings.data.recordingNoticeOn}
              saved={settings.data.recordingNotice}
              canEdit={editable}
              inEffect={recordingOn}
              recorded={recorded}
              eu={eu}
              toast={toast}
            />
          )}
        </Loading>
      </Section>
      {settings.data && days !== undefined && (
        <CallerPrivacyNotice recording={{ on: recordingOn, days }} toast={toast} />
      )}
    </>
  )
}

/**
 * A privacy notice template for callers that the business copies to its website (A11): the business is the controller
 * and must inform callers (GDPR Art. 13/14, CCPA). Shown to everyone who can open the page; copying changes nothing.
 */
function CallerPrivacyNotice({ recording, toast }: { recording: NoticeRecording; toast: (text: string) => void }) {
  const t = useT()
  const text = callerPrivacyNotice(recording, brandName())
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => toast(t('settings.privacyNotice.copied')),
      () => toast(t('settings.privacyNotice.copyFailed')),
    )
  return (
    <Section
      id="st-privacy-notice"
      title={t('settings.privacyNotice.title')}
      description={t('settings.privacyNotice.description')}
      help={t('settings.privacyNotice.help')}
      actions={
        <Button size="sm" onClick={() => void copy()}>
          {t('settings.privacyNotice.copy')}
        </Button>
      }
    >
      <p className="st-privacy-fill">{t('settings.privacyNotice.fill')}</p>
      <pre className="st-privacy-text">{text}</pre>
    </Section>
  )
}

/**
 * `inEffect` false: recording is off on the server, so the assistant does not say it (greyed out, kept as saved).
 * `recorded`: calls are recorded (on the server and kept), so a notice turned off gets a warning; `eu`: the workspace
 * is in the EEA or the UK, for its wording.
 */
type NoticeProps = {
  on: boolean
  saved: string
  canEdit: boolean
  inEffect: boolean
  recorded: boolean
  eu: boolean
  toast: (text: string) => void
}

/** The switch and the sentence the assistant says right after the greeting. */
function RecordingNotice({ on, saved, canEdit, inEffect, recorded, eu, toast }: NoticeProps) {
  const t = useT()
  const run = useRun()
  const [draft, setDraft] = useState(saved)
  const [confirmOff, setConfirmOff] = useState(false)
  const text = draft.trim()
  const problem = !text
    ? t('settings.recordings.noticeEmpty')
    : text.length > RECORDING_NOTICE_MAX
      ? t('settings.recordings.noticeTooLong', { max: RECORDING_NOTICE_MAX })
      : null

  // Turning it off asks first, with a short legal hint (A4); the change is in the audit log (audit.ts).
  function toggle(next: boolean) {
    if (!next) return setConfirmOff(true)
    apply(next)
  }

  function apply(next: boolean) {
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
        dimmed={!inEffect}
      />
      {!on && recorded && (
        <Note tone="warning">
          {eu ? t('settings.recordings.noticeOffWarningEu') : t('settings.recordings.noticeOffWarning')}
        </Note>
      )}
      {confirmOff && (
        <Dialog
          title={t('settings.recordings.noticeOffTitle')}
          description={t('settings.recordings.noticeOffHint')}
          size="sm"
          onClose={() => setConfirmOff(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirmOff(false)}>
                {t('common.action.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirmOff(false)
                  apply(false)
                }}
              >
                {t('settings.recordings.noticeOffConfirm')}
              </Button>
            </>
          }
        />
      )}
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
              disabled={!canEdit}
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
