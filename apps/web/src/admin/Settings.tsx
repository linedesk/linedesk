// Server admin's setting pages (LIN-693), each a section of its own in the nav (route.ts): Calls and Tools under
// Assistant, Sign-up under Customers. Phone numbers is GermanNumbers (SettingsCards.tsx). They were the tabs of one
// Settings page before. Services are connected under Providers; a setting that needs one links there.
import { type ProviderName } from '@linedesk/actions'
import { T, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { appLink } from '../ui/AppLink.tsx'
import { Card } from '../ui/form.tsx'
import { SkeletonRows } from '../ui/LoadStates.tsx'
import { AfterCallTranscript } from './AfterCallTranscript.tsx'
import type { AdminData } from './api.ts'
import { SelfServeCard, SignupRulesCard } from './Billing.tsx'
import { CalendarTools } from './CalendarTools.tsx'
import { CallQualityCard } from './CallQuality.tsx'
import { InternationalTransfers } from './InternationalTransfers.tsx'
import type { Notify } from './notify.ts'
import { FounderEmail, SetupEmails } from './Onboarding.tsx'
import { ProviderDialogFor } from './Providers.tsx'
import type { ProviderStatusState } from './providerStatus.ts'
import { VoiceCloning, Zapier } from './SettingsCards.tsx'
import { SignupAccess } from './SignupAccess.tsx'

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

/** Calls: the call quality levels, after-call transcription, international transfers and voice cloning. */
export function CallSettings(providers: ProvidersProps) {
  return (
    <>
      <CallQualityCard notify={providers.notify} />
      <TranscriptCard {...providers} />
      <InternationalTransfers />
      <VoiceCloning />
    </>
  )
}

/** Sign-up: self-serve sign-up, who may sign up and from where, its limits, and the emails new workspaces get. */
export function SignupSettings({ notify }: { notify: Notify }) {
  return (
    <>
      <SelfServeCard notify={notify} />
      <SignupAccess />
      <SignupRulesCard notify={notify} />
      <SetupEmails />
      <FounderEmail />
    </>
  )
}

/** Tools: which calendar tools members may connect, and the link to the app on Zapier. */
export function ToolSettings() {
  return (
    <>
      <CalendarToolsCard />
      <Zapier />
    </>
  )
}
