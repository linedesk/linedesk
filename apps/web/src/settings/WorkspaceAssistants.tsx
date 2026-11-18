// Workspace settings › Assistants (#workspace/assistants): the workspace's assistants, each a row that opens its own
// settings (#assistant/<id>/general), for whoever looks for them here rather than under Assistant in the menu.
// Owners and admins can add one (assistant.create, the assistant header's New assistant); the new one opens once it
// has arrived by sync.
import type { Assistant, PhoneNumber } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { formatNumber } from '../onboarding/flow.ts'
import { useAssistants, useRows, useRun } from '../store.tsx'
import { Button, Icon } from '../ui/kit.tsx'
import { List, ListEmpty } from '../ui/list.tsx'
import { Loading, SkeletonList, useLoadState } from '../ui/LoadStates.tsx'
import { Section } from './fields.tsx'
import './workspace-assistants.css'

/** Where an assistant's settings open: its first section. */
export const assistantSettingsHash = (id: string) => `#assistant/${id}/general`

export type AssistantRow = { id: string; name: string; href: string; numbers: string[] }

/**
 * One row per assistant, oldest first (the order of useAssistants: the first is the default), with the numbers it
 * answers: those that name it, and for the default one also those that name none (AssistantHeader's number chips).
 */
export function assistantRows(
  assistants: readonly Pick<Assistant, 'id' | 'name'>[],
  numbers: readonly Pick<PhoneNumber, 'e164' | 'assistant_id' | 'created_at'>[],
): AssistantRow[] {
  const sorted = [...numbers].sort((a, b) => a.created_at.localeCompare(b.created_at))
  return assistants.map((a, i) => ({
    id: a.id,
    name: a.name,
    href: assistantSettingsHash(a.id),
    numbers: sorted.filter(n => n.assistant_id === a.id || (!n.assistant_id && i === 0)).map(n => formatNumber(n.e164)),
  }))
}

export function WorkspaceAssistants({ canEdit, toast }: { canEdit: boolean; toast: (text: string) => void }) {
  const t = useT()
  const run = useRun()
  const assistants = useAssistants()
  const numbers = useRows('phone_numbers')
  const load = useLoadState('assistants')
  // A new assistant arrives by sync: open its settings as soon as it is there.
  const [awaiting, setAwaiting] = useState<Set<string> | null>(null)
  useEffect(() => {
    if (!awaiting) return
    const added = assistants.find(a => !awaiting.has(a.id))
    if (!added) return
    setAwaiting(null)
    toast(t('settings.assistantHeader.added', { name: added.name }))
    window.location.hash = assistantSettingsHash(added.id)
  }, [assistants, awaiting, toast, t])
  const rows = assistantRows(assistants, numbers)
  return (
    <Section
      id="ws-assistants"
      title={t('settings.workspace.nav.assistants.label')}
      description={t('settings.workspace.assistants.description')}
      actions={
        canEdit && (
          <Button
            size="sm"
            icon="plus"
            disabled={!!awaiting}
            onClick={() => {
              setAwaiting(new Set(assistants.map(a => a.id)))
              void run('assistant.create', {})
            }}
          >
            {t('settings.assistantHeader.new')}
          </Button>
        )
      }
    >
      <Loading
        what={t('settings.workspace.nav.assistants.label')}
        loading={load !== 'ready'}
        error={load === 'slow'}
        skeleton={<SkeletonList rows={1} />}
      >
        {rows.length > 0 ? (
          <List label={t('settings.workspace.nav.assistants.label')} className="wa-list">
            {rows.map(r => (
              <li key={r.id} className="k-row">
                <a
                  className="k-row-line wa-row"
                  href={r.href}
                  title={t('settings.workspace.assistants.open', { name: r.name })}
                >
                  <span className="k-row-main">
                    <span className="k-row-title">
                      <span className="k-row-text">{r.name}</span>
                    </span>
                    <span className="k-row-sub">
                      {r.numbers.length ? r.numbers.join(', ') : t('settings.workspace.assistants.noNumber')}
                    </span>
                  </span>
                  <span className="wa-go" aria-hidden="true">
                    <Icon name="down" size={14} />
                  </span>
                </a>
              </li>
            ))}
          </List>
        ) : (
          <ListEmpty>{t('settings.workspace.assistants.empty')}</ListEmpty>
        )}
      </Loading>
    </Section>
  )
}
