// Server admin › Features (LIN-747): what workspaces get on this server, the Calls, Phone numbers and Tools sections
// before; and Server admin › Call quality (the nav groups, 2026-11-24): the quality levels, the reply delay, after-call
// transcription and the call reviews. Sign-up & access is in Billing.tsx. Services are connected under Providers; a
// setting that needs one links there.
import { T, useT } from '@linedesk/i18n/react'
import { appLink } from '../ui/AppLink.tsx'
import { Card } from '../ui/form.tsx'
import { SkeletonRows } from '../ui/LoadStates.tsx'
import { AfterCallTranscript } from './AfterCallTranscript.tsx'
import type { AdminData } from './api.ts'
import { CalendarTools } from './CalendarTools.tsx'
import { CallQualityCard } from './CallQuality.tsx'
import { CallReviews } from './CallReviews.tsx'
import { InternationalTransfers } from './InternationalTransfers.tsx'
import type { Notify } from './notify.ts'
import type { ProviderStatusState } from './providerStatus.ts'
import { ReplyDelay } from './ReplyDelay.tsx'
import { ZAPIER_SETTING } from './route.ts'
import { GermanNumbers, VoiceCloning, Zapier } from './SettingsCards.tsx'

type ProvidersProps = {
  /** The admin data (null until it is read) and the providers' status, as AdminMode holds them for every page. */
  data: AdminData | null
  status: ProviderStatusState
  reload: () => Promise<void>
  notify: Notify
}

/** After-call transcription: off, or which connected service transcribes recordings again (connected under Providers). */
function TranscriptCard({ data }: Pick<ProvidersProps, 'data'>) {
  const t = useT()
  return (
    <Card title={t('admin.afterCallTranscript.title')}>
      {data ? <AfterCallTranscript data={data} /> : <SkeletonRows rows={3} columns={2} className="adm-sk-rows" />}
    </Card>
  )
}

/** Which calendar tools members may connect; the install's own apps for one click are connected under Providers. */
function CalendarToolsCard() {
  const t = useT()
  return (
    <Card
      title={t('admin.settings.calendarTools.title')}
      description={<T k="admin.settings.calendarTools.help" values={{ link: appLink('#admin/providers/calendar') }} />}
    >
      <CalendarTools />
    </Card>
  )
}

/**
 * Call quality: how good calls are and how they went, in one page: the levels assistants can pick, the reply delay,
 * after-call transcription and the calls the evaluation flagged.
 */
export function CallQualityPage(providers: ProvidersProps) {
  return (
    <>
      <CallQualityCard notify={providers.notify} />
      <ReplyDelay />
      <TranscriptCard data={providers.data} />
      <CallReviews />
    </>
  )
}

/**
 * Features: what workspaces get on this server, in one page: transfers abroad, the German numbers they can buy, voice
 * cloning, the calendar tools they may connect and the Zapier link.
 */
export function Features({ focus }: { focus?: string | null }) {
  return (
    <>
      <InternationalTransfers />
      <GermanNumbers />
      <VoiceCloning />
      <CalendarToolsCard />
      <Zapier focused={focus === ZAPIER_SETTING} />
    </>
  )
}
