// Server admin › Settings (LIN-693): what this server does, in four tabs, each its own address
// (`#admin/settings/<tab>`, route.ts): Calls (the call quality levels, after-call transcription, international
// transfers, voice cloning), Phone numbers (German numbers), Sign-up (self-serve sign-up, the countries, its limits and
// the emails new workspaces get) and Integrations (which calendar tools members may connect, the Zapier link).
// Services are connected under Providers; a setting that needs one links there.
import { type ProviderName } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
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
import { SETTINGS_TABS, type SettingsTab } from './route.ts'
import { GermanNumbers, VoiceCloning, Zapier } from './SettingsCards.tsx'
import { SignupAccess } from './SignupAccess.tsx'

const TAB_LABELS: Record<SettingsTab, MessageKey> = {
  calls: msg('admin.settings.tab.calls'),
  numbers: msg('admin.settings.tab.numbers'),
  signup: msg('admin.settings.tab.signup'),
  integrations: msg('admin.settings.tab.integrations'),
}

/** The tabs as links: each has its own address, so Back, reload and a link from elsewhere land on it. */
function SettingsTabs({ tab }: { tab: SettingsTab }) {
  const t = useT()
  return (
    <nav className="adm-billtabs" aria-label={t('admin.settings.tabs')}>
      <div className="ib-tabs">
        {SETTINGS_TABS.map(id => (
          <a key={id} href={`#admin/settings/${id}`} className="ib-tab" aria-current={id === tab ? 'page' : undefined}>
            {t(TAB_LABELS[id])}
          </a>
        ))}
      </div>
    </nav>
  )
}

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

type Props = ProvidersProps & { tab: SettingsTab }

export function Settings({ tab, ...providers }: Props) {
  return (
    <>
      <SettingsTabs tab={tab} />
      {tab === 'calls' && (
        <>
          <CallQualityCard notify={providers.notify} />
          <TranscriptCard {...providers} />
          <InternationalTransfers />
          <VoiceCloning />
        </>
      )}
      {tab === 'numbers' && <GermanNumbers />}
      {tab === 'signup' && (
        <>
          <SelfServeCard notify={providers.notify} />
          <SignupAccess />
          <SignupRulesCard notify={providers.notify} />
          <SetupEmails />
          <FounderEmail />
        </>
      )}
      {tab === 'integrations' && (
        <>
          <CalendarToolsCard />
          <Zapier />
        </>
      )}
    </>
  )
}
