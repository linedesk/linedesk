// Workspace settings that are not about the assistant's words: phone numbers (and, next to them,
// notifications and recordings). One page with sections, reached by G S, the menu and ⌘K.
import type { PhoneSetupStatus } from '../auth.ts'
import { PhoneNumbers } from './PhoneNumbers.tsx'

type Props = {
  canEdit: boolean
  phoneSetup: PhoneSetupStatus | null
  isInstanceAdmin: boolean
  toast: (text: string) => void
}

export function SettingsPage({ canEdit, phoneSetup, isInstanceAdmin }: Props) {
  return (
    <div className="page">
      <div className="page-in st-page">
        <div className="page-head">
          <div>
            <h1>Settings</h1>
            <p>Phone numbers for this workspace.</p>
          </div>
        </div>
        <PhoneNumbers canEdit={canEdit} status={phoneSetup} isInstanceAdmin={isInstanceAdmin} />
      </div>
    </div>
  )
}
