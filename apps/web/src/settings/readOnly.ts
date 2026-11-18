// What a member sees on a settings page they cannot change (workspace rights: only admins and the owner change
// workspace settings; docs/architecture.md, "Workspace rights"), and an instance admin during support access, who
// may change none of them but API keys (apps/api/src/impersonation-guard.ts, IMPERSONATION_ALLOWED_WRITES).
import { useT } from '@linedesk/i18n/react'
import type { Me } from '../auth.ts'
import { useSupportAccess } from '../supportAccess.ts'

/**
 * Who changes what in the workspace's settings. `canEdit`: an owner's or admin's own session; `canManageKeys`: their
 * API keys and Zapier (Integrations), also during support access, where they are marked as the admin's.
 */
export function settingsAccess(me: Pick<Me, 'permissions' | 'impersonation'>) {
  const canManageKeys = me.permissions.includes('settings:write')
  return { canEdit: canManageKeys && !me.impersonation, canManageKeys }
}

/** Why a settings field is read-only: support access, else "Only admins can change this." */
export function useReadOnlyNote(): string {
  const t = useT()
  return useSupportAccess() ? t('settings.readOnly.supportAccess') : t('settings.readOnly.onlyAdmins')
}

/**
 * Why a whole section is read-only, said once at its top (ReadOnlyNote in fields.tsx), not under every field: support
 * access, else "Only admins can change these settings."
 */
export function useReadOnlySection(): string {
  const t = useT()
  return useSupportAccess() ? t('settings.readOnly.supportAccess') : t('settings.readOnly.section')
}
