// The transfer contact every new assistant starts with ("Owner", for callers who ask for a person, defaultTransfers in
// @linedesk/db) is the workspace's owner: Transfers shows their name (with "You" for the owner themself) instead of
// the word "Owner" (LIN-766). Only on screen: the contact keeps its saved name, which the assistant reads.
import { DEFAULT_TRANSFERS } from '@linedesk/db/types'
import { useT } from '@linedesk/i18n/react'
import { useCallback } from 'react'
import { useRows } from '../store.tsx'
import { useTeam } from '../team/team-api.ts'
import type { TransferDraft } from './assistantDraft.ts'

/** Who a contact is on screen: the owner's name, and whether that is the signed-in member. */
export type ContactWho = { name: string; you: boolean }

const DEFAULT_ID = DEFAULT_TRANSFERS[0]!.id

/** The owner's contact: the default one, still named as made (English, the UI language) or after the owner. */
export function isOwnerContact(c: Pick<TransferDraft, 'id' | 'name'>, ownerName: string, localName: string): boolean {
  if (c.id !== DEFAULT_ID) return false
  const name = c.name.trim().toLowerCase()
  return [DEFAULT_TRANSFERS[0]!.name, localName, ownerName].some(n => n.trim() && n.trim().toLowerCase() === name)
}

/** For each contact: who it is when it is the owner's (null for everyone else, and before the members are known). */
export function useContactWho(): (c: Pick<TransferDraft, 'id' | 'name'>) => ContactWho | null {
  const t = useT()
  const owner = useRows('workspace_members').find(m => m.role === 'owner' && !m.disabled)
  const me = useTeam().data?.me
  const localName = t('settings.transfer.defaultName')
  return useCallback(
    c => {
      const name = owner?.name.trim()
      if (!owner || !name || !isOwnerContact(c, name, localName)) return null
      return { name, you: owner.user_id === me }
    },
    [owner, me, localName],
  )
}
