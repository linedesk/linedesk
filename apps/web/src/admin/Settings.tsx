// Server admin › Features (LIN-747): what workspaces get on this server, the Calls, Phone numbers and Tools sections
// before. Billing › Sign-up is in Billing.tsx. Services are connected under Providers; a setting that needs one links there.
import { type ProviderName } from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { appLink } from '../ui/AppLink.tsx'
import { Card } from '../ui/form.tsx'
import { SkeletonRows } from '../ui/LoadStates.tsx'
import { AfterCallTranscript } from './AfterCallTranscript.tsx'
import type { AdminData } from './api.ts'
import { CalendarTools } from './CalendarTools.tsx'
import { CallQualityCard } from './CallQuality.tsx'
import { InternationalTransfers } from './InternationalTransfers.tsx'
import type { Notify } from './notify.ts'
import { ProviderDialogFor } from './Providers.tsx'
import type { ProviderStatusState } from './providerStatus.ts'
import { ZAPIER_SETTING } from './route.ts'
import { GermanNumbers, VoiceCloning, Zapier } from './SettingsCards.tsx'

type ProvidersProps = {
  /** The admin data (null until it is read) and the providers' status, as AdminMode holds them for every page. */
  data: AdminData | null
  status: ProviderStatusState
  reload: () => Promise<void>
  notify: Notify
}

/** After-call transcription: off, or which provider transcribes recordings again; a provider's key opens its dialog. */
function TranscriptCard({ data, status, reload, notify }: ProvidersProps) {
  const t = useT()
  const [open, setOpen] = useState<ProviderName | null>(null)
  return (
    <Card title={t('admin.afterCallTranscript.title')}>
      {data ? (
        <AfterCallTranscript data={data} onOpen={setOpen} />
      ) : (
        <SkeletonRows rows={3} columns={2} className="adm-sk-rows" />
      )}
      {open && data && (
        <ProviderDialogFor
          name={open}
          data={data}
          status={status}
          reload={reload}
          notify={notify}
          onClose={() => setOpen(null)}
        />
      )}
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
 * Features: what workspaces get on this server, in one page: the call quality levels, after-call transcription,
 * transfers abroad, the German numbers they can buy, voice cloning, the calendar tools they may connect and the Zapier link.
 */
export function Features({ focus, ...providers }: ProvidersProps & { focus?: string | null }) {
  return (
    <>
      <CallQualityCard notify={providers.notify} />
      <TranscriptCard {...providers} />
      <InternationalTransfers />
      <GermanNumbers />
      <VoiceCloning />
      <CalendarToolsCard />
      <Zapier focused={focus === ZAPIER_SETTING} />
    </>
  )
}
