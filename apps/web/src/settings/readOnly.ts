// What a member sees on a settings page they cannot change (workspace rights: only admins and the owner change
// workspace settings; docs/architecture.md, "Workspace rights").
import { i18n } from '../i18n/index.tsx'

/** "Only admins can change this." in the active language. */
export const onlyAdmins = () => i18n().t('settings.readOnly.onlyAdmins')
