// Workspace settings: everything about the workspace that is not the assistant, one section at a time
// (#workspace/<section>): its name, the team, phone numbers, recordings, the call export, API keys and leaving it.
// Reached by G S (G T opens Team), the menu and ⌘K. Your own notifications are in Account; business hours and
// webhooks in the assistant's settings (old #settings and #team links are rewritten, shell/useRoute.ts).
import { workspaceNameProblem } from '@linedesk/actions'
import { type KeyboardEvent, useEffect, useState } from 'react'
import type { PhoneSetupStatus } from '../auth.ts'
import { useRun } from '../store.tsx'
import { LeaveWorkspace, TeamSection } from '../team/TeamPage.tsx'
import { useTeam } from '../team/team-api.ts'
import { Input } from '../ui/form.tsx'
import { Skeleton } from '../ui/LoadStates.tsx'
import { type PageSection, SettingsLayout, useSection } from '../ui/SettingsLayout.tsx'
import { Developers } from './Developers.tsx'
import { ExportCalls } from './ExportCalls.tsx'
import { Field, Section } from './fields.tsx'
import { PhoneNumbers } from './PhoneNumbers.tsx'
import { Recordings } from './Recordings.tsx'

type SectionId = 'general' | 'team' | 'phone' | 'recordings' | 'export' | 'developers' | 'danger'
const sections: readonly PageSection<SectionId>[] = [
  { id: 'general', label: 'General', description: 'The business name' },
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
          <General canEdit={canEdit} name={workspaceName} onRenamed={onRenamed} toast={toast} />
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

/** The business name (the workspace's name): saved on Enter or when the field loses focus; Esc puts it back. */
function General({
  canEdit,
  name,
  onRenamed,
  toast,
}: {
  canEdit: boolean
  name: string
  onRenamed: (name: string) => void
  toast: (text: string) => void
}) {
  const run = useRun()
  const [draft, setDraft] = useState(name)
  // Renamed elsewhere (another tab, onboarding): the field follows.
  useEffect(() => setDraft(name), [name])
  const next = draft.trim()
  const problem = next === name ? null : workspaceNameProblem(next)

  function save() {
    if (next === name || problem) return
    void run('workspace.rename', { name: next })
    onRenamed(next)
    setDraft(next)
    toast(`Renamed to ${next}.`)
  }
  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      save()
    } else if (e.key === 'Escape' && draft !== name) {
      e.stopPropagation() // Esc puts the name back; it does not leave the page
      setDraft(name)
    }
  }

  return (
    <Section id="ws-general" title="General">
      <Field
        id="ws-name"
        label="Business name"
        help={canEdit ? 'In the menu, the workspace switcher and emails.' : 'Only owners and admins can change this.'}
        error={problem}
      >
        <Input
          id="ws-name"
          value={draft}
          readOnly={!canEdit}
          invalid={!!problem}
          autoComplete="organization"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={save}
        />
      </Field>
    </Section>
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
