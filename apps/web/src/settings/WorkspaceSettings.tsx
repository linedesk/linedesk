// Workspace settings: everything about the workspace that is not the assistant, one section at a time
// (#workspace/<section>): its name, the team, phone numbers, recordings, the call export, API keys and leaving it.
// Reached by G S (G T opens Team), the menu and ⌘K. Your own notifications are in Account; business hours and
// webhooks in the assistant's settings (old #settings and #team links are rewritten, shell/useRoute.ts).
import type { PhoneSetupStatus } from '../auth.ts'
import { LeaveWorkspace, TeamSection } from '../team/TeamPage.tsx'
import { useTeam } from '../team/team-api.ts'
import { Skeleton } from '../ui/LoadStates.tsx'
import { type PageSection, SettingsLayout, useSection } from '../ui/SettingsLayout.tsx'
import { Developers } from './Developers.tsx'
import { ExportCalls } from './ExportCalls.tsx'
import { PhoneNumbers } from './PhoneNumbers.tsx'
import { Recordings } from './Recordings.tsx'
import { WorkspaceGeneral } from './WorkspaceGeneral.tsx'

type SectionId = 'general' | 'team' | 'phone' | 'recordings' | 'export' | 'developers' | 'danger'
const sections: readonly PageSection<SectionId>[] = [
  { id: 'general', label: 'General', description: 'Business name, time zone, appointment value' },
  { id: 'team', label: 'Team', description: 'Who is in the workspace, invitations' },
  { id: 'phone', label: 'Phone numbers', description: 'The numbers the assistant answers' },
  { id: 'recordings', label: 'Recordings', description: 'How long recordings are kept, recording notice' },
  { id: 'export', label: 'Export calls', description: 'Download calls as a CSV file' },
  { id: 'developers', label: 'Developers', description: 'API keys for your own tools' },
  { id: 'danger', label: 'Danger zone', description: 'Leave this workspace' },
]
/** Members can't export calls or manage API keys (call:export, settings:write): those sections are not shown. */
const memberSections = sections.filter(s => s.id !== 'export' && s.id !== 'developers')

type Props = {
  canEdit: boolean
  phoneSetup: PhoneSetupStatus | null
  isInstanceAdmin: boolean
  workspaceName: string
  /** After a rename here: the menu and the workspace switcher show the new name at once (App, renamedWorkspace). */
  onRenamed: (name: string) => void
  toast: (text: string) => void
}

export function WorkspaceSettings({ canEdit, phoneSetup, isInstanceAdmin, workspaceName, onRenamed, toast }: Props) {
  const shown = canEdit ? sections : memberSections
  const current = useSection('workspace', shown)
  return (
    <div className="page">
      <SettingsLayout
        page="workspace"
        title="Workspace settings"
        description={workspaceName}
        sections={shown}
        current={current}
      >
        {current === 'general' && (
          <WorkspaceGeneral canEdit={canEdit} name={workspaceName} onRenamed={onRenamed} toast={toast} />
        )}
        {current === 'team' && <TeamSection toast={toast} />}
        {current === 'phone' && (
          <PhoneNumbers canEdit={canEdit} status={phoneSetup} isInstanceAdmin={isInstanceAdmin} />
        )}
        {current === 'recordings' && <Recordings canEdit={canEdit} toast={toast} />}
        {current === 'export' && <ExportCalls canEdit={canEdit} toast={toast} />}
        {current === 'developers' && <Developers canEdit={canEdit} toast={toast} />}
        {current === 'danger' && <DangerZone />}
      </SettingsLayout>
    </div>
  )
}

/** Leaving the workspace; blocked for its last owner. Deleting a workspace comes later. */
function DangerZone() {
  const team = useTeam()
  const data = team.data ?? null
  if (data) return <LeaveWorkspace data={data} />
  return team.error ? (
    <div className="empty">
      <b>The team could not be loaded</b>
      <span>{team.error}</span>
    </div>
  ) : (
    <div role="status" aria-busy="true" aria-label="Loading">
      <Skeleton className="sk-card" />
    </div>
  )
}
