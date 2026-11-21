// Support access: an instance admin signed in as this user (docs/architecture.md §12). The server refuses every write
// but inbox triage and API keys then (apps/api/src/impersonation-guard.ts), and the person's own account (profile,
// sign-in, sessions, invitations). The app says so calmly instead of offering what would be refused.
// ImpersonationFrame provides it around the whole signed-in app.
import { isAgentSetupHash } from '@linedesk/actions'
import { createContext, useContext } from 'react'
import { i18n } from './i18n/index.tsx'
import { CHANGE_WITH_AGENT_HASH } from './settings/agentChange.ts'

/** Support access that is read-only: an instance admin signed in as another user, edits not allowed (LIN-708). */
export const SupportAccessContext = createContext(false)
/** Any support access, also with edits allowed: the person's own account (sign-in, profile) stays theirs. */
export const ImpersonatingContext = createContext(false)

/** Whether this tab is an instance admin's read-only support access; with edits allowed it works as the user. */
export const useSupportAccess = () => useContext(SupportAccessContext)
/** Whether this tab is an instance admin's support access at all, with or without edits. */
export const useImpersonating = () => useContext(ImpersonatingContext)

/**
 * Pages that open only in the person's own session, never during support access (the server refuses their setup links
 * then): the AI agent setup (#setup-agent) and Change with an AI agent (#change-with-agent/…).
 */
export const ownSessionOnly = (hash: string) => isAgentSetupHash(hash) || hash.startsWith(`${CHANGE_WITH_AGENT_HASH}/`)

/** What the inbox says when the address named no page: why it did not open during support access. */
export const unknownPageText = (hash: string, supportAccess: boolean) =>
  supportAccess && ownSessionOnly(hash) ? i18n().t('shell.lost.supportAccess') : i18n().t('shell.lost.page')
