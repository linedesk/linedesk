// Workspace settings that are not about the assistant: phone numbers, call details, recordings, webhooks and
// API keys, one section at a time (#settings/<section>). Reached by G S, the menu and ⌘K. Business hours and
// notifications are in the assistant's settings (old links are rewritten, shell/useRoute.ts).
import type { PhoneSetupStatus } from '../auth.ts'
import { type PageSection, SettingsLayout, useSection } from '../ui/SettingsLayout.tsx'
import { CallDetails } from './CallDetails.tsx'
import { Developers } from './Developers.tsx'
import { PhoneNumbers } from './PhoneNumbers.tsx'
import { Recordings } from './Recordings.tsx'
import { Webhooks } from './Webhooks.tsx'

type SectionId = 'phone' | 'fields' | 'recordings' | 'webhooks' | 'developers'
const sections: readonly PageSection<SectionId>[] = [
  { id: 'phone', label: 'Phone numbers', description: 'The numbers the assistant answers' },
  { id: 'fields', label: 'Call details', description: 'Custom fields on calls, CSV export' },
  { id: 'recordings', label: 'Recordings', description: 'How long recordings are kept, recording notice' },
  { id: 'webhooks', label: 'Webhooks', description: 'Send events to your other tools' },
  { id: 'developers', label: 'Developers', description: 'API keys for your own tools' },
]

type Props = {
  canEdit: boolean
  phoneSetup: PhoneSetupStatus | null
  isInstanceAdmin: boolean
  toast: (text: string) => void
}

export function SettingsPage({ canEdit, phoneSetup, isInstanceAdmin, toast }: Props) {
  const current = useSection('settings', sections)
  return (
    <div className="page">
      <SettingsLayout page="settings" title="Settings" sections={sections} current={current}>
        {current === 'phone' && (
          <PhoneNumbers canEdit={canEdit} status={phoneSetup} isInstanceAdmin={isInstanceAdmin} />
        )}
        {current === 'fields' && <CallDetails canEdit={canEdit} toast={toast} />}
        {current === 'recordings' && <Recordings canEdit={canEdit} toast={toast} />}
        {current === 'webhooks' && <Webhooks canEdit={canEdit} toast={toast} />}
        {current === 'developers' && <Developers canEdit={canEdit} toast={toast} />}
      </SettingsLayout>
    </div>
  )
}
