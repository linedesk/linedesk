// Changing settings with an AI agent (Workspace settings › General, Assistant settings › General): the same agent setup
// page and workspace setup link as the owner's onboarding (onboarding/AgentSetup.tsx, scope "workspace"), opened in
// "change" mode at #change-with-agent/workspace or #change-with-agent/assistant/<id>. The link acts with the person's
// own role there (agentSetup.createWorkspaceKey: owner or admin), so it is offered to exactly those who may change the
// settings themselves; members see nothing of it.
import { useEffect, useState } from 'react'
import type { Me } from '../auth.ts'
import { sectionHash } from '../ui/SettingsLayout.tsx'

export const CHANGE_WITH_AGENT_HASH = '#change-with-agent'

/** What the agent is to change: the workspace's settings, or one assistant's. */
export type ChangeTarget = { kind: 'workspace' } | { kind: 'assistant'; assistantId: string }

/** The page's address for a target. */
export function changeWithAgentHash(target: ChangeTarget): string {
  return target.kind === 'assistant'
    ? `${CHANGE_WITH_AGENT_HASH}/assistant/${encodeURIComponent(target.assistantId)}`
    : `${CHANGE_WITH_AGENT_HASH}/workspace`
}

/** The target an address names, or null when it is not the page (or names nothing it knows). */
export function parseChangeWithAgent(hash: string): ChangeTarget | null {
  if (!hash.startsWith(`${CHANGE_WITH_AGENT_HASH}/`)) return null
  const [kind, id, ...rest] = hash.slice(CHANGE_WITH_AGENT_HASH.length + 1).split('/')
  if (kind === 'workspace' && id === undefined) return { kind: 'workspace' }
  if (kind === 'assistant' && id && rest.length === 0) return { kind: 'assistant', assistantId: decodeURIComponent(id) }
  return null
}

/** Where leaving the page goes: the settings page it was opened from. */
export function settingsHashOf(target: ChangeTarget): string {
  return target.kind === 'assistant'
    ? sectionHash(`assistant/${target.assistantId}`, 'general')
    : sectionHash('workspace', 'general')
}

/**
 * Whether this person is offered the agent here: they change the workspace's settings themselves (owner or admin,
 * settings:write), signed in as themselves (never while a server admin is signed in as them), with a confirmed address
 * (making the link needs one), in a workspace that is not disabled. The server checks all of it again.
 */
export function mayChangeWithAgent(
  me: Pick<Me, 'role' | 'permissions' | 'impersonation' | 'emailUnconfirmed' | 'workspace'>,
): boolean {
  if (me.role !== 'owner' && me.role !== 'admin') return false
  if (!me.permissions.includes('settings:write')) return false
  return !me.impersonation && !me.emailUnconfirmed && !me.workspace?.disabled
}

/** The change target in the address, followed as it changes. */
export function useChangeWithAgent(): ChangeTarget | null {
  const [target, setTarget] = useState(() => parseChangeWithAgent(window.location.hash))
  useEffect(() => {
    const follow = () => setTarget(parseChangeWithAgent(window.location.hash))
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [])
  return target
}
