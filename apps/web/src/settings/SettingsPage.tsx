// Workspace settings that are not about the assistant's words: phone numbers, business hours,
// notifications and recordings, one section at a time (#settings/<section>). Reached by G S, the menu and ⌘K.
import type { PhoneSetupStatus } from '../auth.ts'
import { type PageSection, SettingsLayout, useSection } from '../ui/SettingsLayout.tsx'
import { BusinessHours } from './BusinessHours.tsx'
import { Notifications } from './Notifications.tsx'
import { PhoneNumbers } from './PhoneNumbers.tsx'
import { Recordings } from './Recordings.tsx'

type SectionId = 'phone' | 'hours' | 'notifications' | 'recordings'
const sections: readonly PageSection<SectionId>[] = [
  { id: 'phone', label: 'Phone numbers', description: 'The numbers the assistant answers' },
  { id: 'hours', label: 'Business hours', description: 'When the office is open (optional)' },
  { id: 'notifications', label: 'Notifications', description: 'New calls by email and in the browser' },
  { id: 'recordings', label: 'Recordings', description: 'How long recordings are kept' },
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
        {current === 'hours' && <BusinessHours canEdit={canEdit} toast={toast} />}
        {current === 'notifications' && <Notifications toast={toast} />}
        {current === 'recordings' && <Recordings canEdit={canEdit} toast={toast} />}
      </SettingsLayout>
    </div>
  )
}
