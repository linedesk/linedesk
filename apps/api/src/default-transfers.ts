// The transfer contact every new assistant starts with ("Owner", for callers who ask for a person), named in the
// workspace's UI language: its country's language when the web app has it, else the language of whoever makes it,
// else English (like an invitation, email-locale.ts). Only the name: the condition is for the assistant, in English.
import type { Tx } from '@linedesk/db'
import { defaultTransfers, type TransferContact } from '@linedesk/db/types'
import { SOURCE } from '@linedesk/i18n'
import { getT } from '@linedesk/i18n/server'
import { uiLocaleOf } from './email-locale.ts'
import { workspaceLocale } from './workspace-locale.ts'

/**
 * A new assistant's transfer list for a workspace whose settings row exists (workspaceLocale reads its country).
 * `creatorLocale`: the language of whoever makes the assistant, when the workspace's is not a UI language.
 */
export async function newAssistantTransfers(
  tx: Tx,
  workspaceId: string,
  creatorLocale?: string | null,
): Promise<TransferContact[]> {
  const locale =
    uiLocaleOf((await workspaceLocale(tx, workspaceId)).resolvedLanguage) ?? uiLocaleOf(creatorLocale) ?? SOURCE
  return defaultTransfers(getT(locale).t('server.assistant.defaultTransferName'))
}
