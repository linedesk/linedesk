// Server admin › Call quality (the nav groups, 2026-11-24): the quality levels, the reply delay, after-call
// transcription and the call reviews. Sign-up & access is in Billing.tsx. Services are connected under Providers; a
// setting that needs one links there.
import { useT } from '@linedesk/i18n/react'
import { Card } from '../ui/form.tsx'
import { SkeletonRows } from '../ui/LoadStates.tsx'
import { AfterCallTranscript } from './AfterCallTranscript.tsx'
import type { AdminData } from './api.ts'
import { CallQualityCard } from './CallQuality.tsx'
import { CallReviews } from './CallReviews.tsx'
import type { Notify } from './notify.ts'
import type { ProviderStatusState } from './providerStatus.ts'
import { ReplyDelay } from './ReplyDelay.tsx'

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
