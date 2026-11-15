// Workspace settings: everything about the workspace that is not the assistant, one section at a time
// (#workspace/<section>): its name, the team, phone numbers, recordings, the call export, API keys and leaving it.
// Reached by G S (G T opens Team), the menu and ⌘K. Your own notifications are in Account; business hours and
// webhooks in the assistant's settings (old #settings and #team links are rewritten, shell/useRoute.ts).

import type { MessageKey } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useMemo } from 'react'
import type { PhoneSetupStatus } from '../auth.ts'
import { TeamSection } from '../team/TeamPage.tsx'
import { useTeam } from '../team/team-api.ts'
import { type PageSection, SettingsLayout, useSection } from '../ui/SettingsLayout.tsx'
import { DangerZone } from './DangerZone.tsx'
import { Developers } from './Developers.tsx'
import { ExportCalls } from './ExportCalls.tsx'
import { PhoneNumbers } from './PhoneNumbers.tsx'
import { Recordings } from './Recordings.tsx'
import { WorkspaceGeneral } from './WorkspaceGeneral.tsx'

type SectionId = 'general' | 'team' | 'phone' | 'recordings' | 'export' | 'developers' | 'danger'
const SECTION_IDS: readonly SectionId[] = ['general', 'team', 'phone', 'recordings', 'export', 'developers', 'danger']

/**
 * The page's sections in the active language. Members can't export calls or manage API keys (call:export,
 * settings:write): those sections are not shown.
 */
function useSections(canEdit: boolean): readonly PageSection<SectionId>[] {
  const t = useT()
  return useMemo(
    () =>
      SECTION_IDS.filter(id => canEdit || (id !== 'export' && id !== 'developers')).map(id => ({
        id,
        // i18n-dynamic: settings.workspace.nav.*
        label: t(`settings.workspace.nav.${id}.label` as MessageKey),
        description: t(`settings.workspace.nav.${id}.description` as MessageKey),
      })),
    [t, canEdit],
  )
}

/**
 * What the Danger zone offers this person: the owner can't leave (they hand the workspace over or delete it), everyone
 * else can only leave (deleting is the owner's). The general words while the role isn't known yet.
 */
function dangerDescription(canEdit: boolean, role: string | undefined): MessageKey {
  if (!canEdit || role === 'admin' || role === 'member') return 'settings.workspace.nav.danger.leave'
  if (role === 'owner') return 'settings.workspace.nav.danger.owner'
  return 'settings.workspace.nav.danger.description'
}

type Props = {
  canEdit: boolean
  /** "Change with an AI agent" on top of General (owners and admins, agentChange.ts). */
  agentChange?: boolean
  phoneSetup: PhoneSetupStatus | null
  isInstanceAdmin: boolean
  workspaceName: string
  /** After a rename here: the menu and the workspace switcher show the new name at once (App, renamedWorkspace). */
  onRenamed: (name: string) => void
  toast: (text: string) => void
}

export function WorkspaceSettings({
  canEdit,
  agentChange = false,
  phoneSetup,
  isInstanceAdmin,
  workspaceName,
  onRenamed,
  toast,
}: Props) {
  const t = useT()
  const team = useTeam().data
  const role = team?.members.find(m => m.userId === team.me)?.role
  const sections = useSections(canEdit)
  const danger = t(dangerDescription(canEdit, role))
  const shown = useMemo(
    () => sections.map(s => (s.id === 'danger' ? { ...s, description: danger } : s)),
    [sections, danger],
  )
  const current = useSection('workspace', shown)
  return (
    <div className="page">
      <SettingsLayout
        page="workspace"
        title={t('settings.workspace.title')}
        description={workspaceName}
        sections={shown}
        current={current}
      >
        {current === 'general' && (
          <WorkspaceGeneral
            canEdit={canEdit}
            agentChange={agentChange}
            name={workspaceName}
            onRenamed={onRenamed}
            toast={toast}
          />
        )}
        {current === 'team' && <TeamSection toast={toast} />}
        {current === 'phone' && (
          <PhoneNumbers canEdit={canEdit} status={phoneSetup} isInstanceAdmin={isInstanceAdmin} />
        )}
        {current === 'recordings' && <Recordings canEdit={canEdit} toast={toast} />}
        {current === 'export' && <ExportCalls canEdit={canEdit} toast={toast} />}
        {current === 'developers' && <Developers canEdit={canEdit} toast={toast} />}
        {current === 'danger' && <DangerZone workspaceName={workspaceName} isInstanceAdmin={isInstanceAdmin} />}
      </SettingsLayout>
    </div>
  )
}
