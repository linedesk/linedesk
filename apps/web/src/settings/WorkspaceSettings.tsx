// Workspace settings: everything about the workspace that is not the assistant, one section at a time
// (#workspace/<section>): its name, the team, phone numbers, recordings, the call export, billing (Linedesk Cloud: the
// owner, while the workspace is on a bill) and leaving it.
// Reached by G S (G T opens Team), the menu and ⌘K. Your own notifications are in Account; business hours and
// webhooks in the assistant's settings; API keys and Zapier in Integrations (old #settings, #team and
// #workspace/developers links are rewritten, shell/useRoute.ts).

import type { MessageKey } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useMemo } from 'react'
import type { PhoneSetupStatus } from '../auth.ts'
import { TeamSection } from '../team/TeamPage.tsx'
import { useTeam } from '../team/team-api.ts'
import { type PageSection, SettingsLayout, useSection } from '../ui/SettingsLayout.tsx'
import { Billing } from './Billing.tsx'
import { DangerZone } from './DangerZone.tsx'
import { ExportCalls } from './ExportCalls.tsx'
import { PhoneNumbers } from './PhoneNumbers.tsx'
import { Recordings } from './Recordings.tsx'
import { WorkspaceGeneral } from './WorkspaceGeneral.tsx'

type SectionId = 'general' | 'team' | 'phone' | 'recordings' | 'export' | 'billing' | 'danger'
const SECTION_IDS: readonly SectionId[] = ['general', 'team', 'phone', 'recordings', 'export', 'billing', 'danger']

/**
 * Which sections this person sees. Members can't export calls (call:export): that section is not shown, and during
 * support access the export is refused too. Billing only on a billed workspace, for its owner (`billing`).
 */
export function shownSectionIds(canEdit: boolean, billing = false): SectionId[] {
  return SECTION_IDS.filter(id => (id !== 'export' || canEdit) && (id !== 'billing' || billing))
}

/** The page's sections in the active language (shownSectionIds). */
function useSections(canEdit: boolean, billing: boolean): readonly PageSection<SectionId>[] {
  const t = useT()
  return useMemo(
    () =>
      shownSectionIds(canEdit, billing).map(id => ({
        id,
        // i18n-dynamic: settings.workspace.nav.*
        label: t(`settings.workspace.nav.${id}.label` as MessageKey),
        description: t(`settings.workspace.nav.${id}.description` as MessageKey),
      })),
    [t, canEdit, billing],
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
  /** Owners and admins in their own session (settingsAccess, readOnly.ts). */
  canEdit: boolean
  /** Owners and admins, also during support access: what the Danger zone offers (dangerDescription). */
  canManageKeys: boolean
  /** "Change with an AI agent" on top of General (owners and admins, agentChange.ts). */
  agentChange?: boolean
  phoneSetup: PhoneSetupStatus | null
  isInstanceAdmin: boolean
  /**
   * The workspace is on a bill (Linedesk Cloud, `me.workspace.billingState`): the Billing section, the whole page for
   * the person who may manage billing (`owner`, `billing:manage`), this workspace's usage alone for admins (`usage`).
   * Off billing and for members it is not there at all.
   */
  billing?: 'owner' | 'usage' | null
  /** On a bill: what each extra number costs a month, said where a number is added; null otherwise. */
  extraNumberCents?: number | null
  workspaceName: string
  /** After a rename here: the menu and the workspace switcher show the new name at once (App, renamedWorkspace). */
  onRenamed: (name: string) => void
  toast: (text: string) => void
}

export function WorkspaceSettings({
  canEdit,
  canManageKeys,
  agentChange = false,
  phoneSetup,
  isInstanceAdmin,
  billing = null,
  extraNumberCents = null,
  workspaceName,
  onRenamed,
  toast,
}: Props) {
  const t = useT()
  const team = useTeam().data
  const role = team?.members.find(m => m.userId === team.me)?.role
  const sections = useSections(canEdit, !!billing)
  // What the role offers, also during support access (the section itself then says it is read-only).
  const danger = t(dangerDescription(canManageKeys, role))
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
            isOwner={role === 'owner'}
            name={workspaceName}
            onRenamed={onRenamed}
            toast={toast}
          />
        )}
        {current === 'team' && <TeamSection toast={toast} />}
        {current === 'phone' && (
          <PhoneNumbers
            canEdit={canEdit}
            status={phoneSetup}
            isInstanceAdmin={isInstanceAdmin}
            extraNumberCents={extraNumberCents}
          />
        )}
        {current === 'recordings' && <Recordings canEdit={canEdit} toast={toast} />}
        {current === 'export' && <ExportCalls canEdit={canEdit} toast={toast} />}
        {current === 'billing' && <Billing toast={toast} owner={billing === 'owner'} />}
        {current === 'danger' && <DangerZone workspaceName={workspaceName} isInstanceAdmin={isInstanceAdmin} />}
      </SettingsLayout>
    </div>
  )
}
