import { useMemo } from 'react'
import { useQuery } from '../cachedQuery.ts'
import {
  ADMIN_LISTS,
  ADMIN_PROVIDERS,
  type AdminData,
  loadAdminLists,
  loadAdminProviders,
  reloadAdminData,
} from './api.ts'

/**
 * Server admin's data in two parts that load side by side in the background: the lists (fast) and the providers (the
 * API checks each one, slower). A page waits only for the part it shows; pages that need neither never wait. Shown at
 * once when admin is opened again in this page; loaded again in the background.
 */
export function useAdminData() {
  const lists = useQuery(ADMIN_LISTS, loadAdminLists)
  const providers = useQuery(ADMIN_PROVIDERS, loadAdminProviders)
  const data = useMemo<AdminData | null>(
    () => (lists.data && providers.data ? { ...lists.data, ...providers.data } : null),
    [lists.data, providers.data],
  )
  return {
    lists: lists.data ?? null,
    providers: providers.data ?? null,
    /** Both parts, for Providers and the install walkthrough. */
    data,
    listsError: lists.data ? null : lists.error,
    providersError: providers.data ? null : providers.error,
    reload: reloadAdminData,
  }
}
