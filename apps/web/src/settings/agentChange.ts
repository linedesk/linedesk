// Changing settings with an AI agent (Workspace settings › General, Assistant settings › General): the same agent setup
// page and workspace setup link as the owner's onboarding (onboarding/AgentSetup.tsx, scope "workspace"), opened in
// "change" mode at #change-with-agent/workspace or #change-with-agent/assistant/<id>. The link acts with the person's
// own role there (agentSetup.createWorkspaceKey: owner or admin), so it is offered to exactly those who may change the
// settings themselves; members see nothing of it. "Step by step" beside it opens the setup flow the workspace was set up
// with (onboarding/StepByStep.tsx) at #step-by-step/workspace or #step-by-step/assistant/<id>, with the saved values.
import { useEffect, useState } from 'react'
import type { Me } from '../auth.ts'
import { sectionHash } from '../ui/SettingsLayout.tsx'
import { settingsAccess } from './readOnly.ts'

export const CHANGE_WITH_AGENT_HASH = '#change-with-agent'
export const STEP_BY_STEP_HASH = '#step-by-step'

/** What the agent is to change: the workspace's settings, or one assistant's. */
export type ChangeTarget = { kind: 'workspace' } | { kind: 'assistant'; assistantId: string }

/** A page's address for a target: under `base`, the agent page (CHANGE_WITH_AGENT_HASH) or step by step. */
function targetHash(base: string, target: ChangeTarget): string {
  return target.kind === 'assistant'
    ? `${base}/assistant/${encodeURIComponent(target.assistantId)}`
    : `${base}/workspace`
}

/** The target an address under `base` names, or null when it is not that page (or names nothing it knows). */
function parseTarget(base: string, hash: string): ChangeTarget | null {
  if (!hash.startsWith(`${base}/`)) return null
  const [kind, id, ...rest] = hash.slice(base.length + 1).split('/')
  if (kind === 'workspace' && id === undefined) return { kind: 'workspace' }
  if (kind === 'assistant' && id && rest.length === 0) return { kind: 'assistant', assistantId: decodeURIComponent(id) }
  return null
}

/** The agent page's address for a target. */
export const changeWithAgentHash = (target: ChangeTarget): string => targetHash(CHANGE_WITH_AGENT_HASH, target)

/** The target the agent page's address names, or null when it is not the page (or names nothing it knows). */
export const parseChangeWithAgent = (hash: string): ChangeTarget | null => parseTarget(CHANGE_WITH_AGENT_HASH, hash)

/** The step-by-step setup flow's address for a target. */
export const stepByStepHash = (target: ChangeTarget): string => targetHash(STEP_BY_STEP_HASH, target)

/** The target the step-by-step address names, or null when it is not that page. */
export const parseStepByStep = (hash: string): ChangeTarget | null => parseTarget(STEP_BY_STEP_HASH, hash)

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

/** A target in the address (`parse`), followed as it changes. */
function useTargetIn(parse: (hash: string) => ChangeTarget | null): ChangeTarget | null {
  const [target, setTarget] = useState(() => parse(window.location.hash))
  useEffect(() => {
    const follow = () => setTarget(parse(window.location.hash))
    window.addEventListener('hashchange', follow)
    return () => window.removeEventListener('hashchange', follow)
  }, [parse])
  return target
}

/** The agent page's target in the address, followed as it changes. */
export const useChangeWithAgent = (): ChangeTarget | null => useTargetIn(parseChangeWithAgent)

/** The step-by-step flow's target in the address, followed as it changes. */
export const useStepByStep = (): ChangeTarget | null => useTargetIn(parseStepByStep)

/**
 * Whether this person may go through the setup flow again: they change the settings themselves (settingsAccess, an
 * owner's or admin's own session), in a workspace that is not disabled. The server checks every save again.
 */
export function mayStepThrough(me: Pick<Me, 'permissions' | 'impersonation' | 'workspace'>): boolean {
  return settingsAccess(me).canEdit && !me.workspace?.disabled
}
