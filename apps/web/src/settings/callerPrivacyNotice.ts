// Settings › Recordings › Caller privacy notice: a short template the business copies to its website or privacy page.
// The business is the controller and has to tell callers what happens to their data (GDPR Art. 13/14, CCPA notice at
// collection); the recording sentence follows the workspace's own settings, the rest is filled in by the business in
// [brackets]. Plain text, paragraphs split by a blank line, so it pastes cleanly anywhere.
// The Linedesk facts here (providers, US transfers, DPF/SCC) change in the same change as privacy.html or providers.
import { RECORDINGS_NOT_KEPT } from '@linedesk/actions'
import { i18n } from '../i18n/index.tsx'

export type NoticeRecording = {
  /** Recording is on on this server (a recording store is set up). */
  on: boolean
  /** The workspace's retention: days, RECORDINGS_NOT_KEPT (0) for none, null for until the call is deleted. */
  days: number | null
}

/** The recording sentence's case: audio kept for some days, kept until the call is deleted, or not kept at all. */
export function recordingKind({ on, days }: NoticeRecording): 'days' | 'forever' | 'none' {
  if (!on || days === RECORDINGS_NOT_KEPT) return 'none'
  return days === null ? 'forever' : 'days'
}

/** The notice as plain text, in the active language, with `brand` as the processor that runs the assistant. */
export function callerPrivacyNotice(recording: NoticeRecording, brand: string): string {
  const { t } = i18n()
  const kind = recordingKind(recording)
  return [
    t('settings.privacyNotice.text.title'),
    t('settings.privacyNotice.text.who'),
    `${t('settings.privacyNotice.text.what')} ${t('settings.privacyNotice.text.recording', { kind, days: recording.days ?? 0 })}`,
    t('settings.privacyNotice.text.why'),
    t('settings.privacyNotice.text.processor', { brand }),
    t('settings.privacyNotice.text.retention'),
    t('settings.privacyNotice.text.rights'),
    t('settings.privacyNotice.text.contact'),
  ].join('\n\n')
}
