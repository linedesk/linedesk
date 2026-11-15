// What a member sees on a settings page they cannot change (workspace rights: only admins and the owner change
// workspace settings; docs/architecture.md, "Workspace rights").
import { i18n } from '../i18n/index.tsx'

/** "Only admins can change this." in the active language. */
export const onlyAdmins = () => i18n().t('settings.readOnly.onlyAdmins')

/** The English text, for team/TeamPage.tsx until it moves to onlyAdmins() (outside settings; LIN-279 follow-up). */
export const ONLY_ADMINS = 'Only admins can change this.'
