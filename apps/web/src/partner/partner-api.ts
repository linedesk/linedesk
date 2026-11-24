// The partner area's link to the API (docs/white-label.md): partner actions run directly (callAction), not through
// the outbox, since partner rows are not synced to the browser. A refusal with a partner code is worded here.
import {
  type MyPartner,
  PARTNER_CODES,
  UNPAID_PARTNER_CLIENTS,
  type PartnerClientList,
  type PartnerData,
} from '@linedesk/actions'
import type { MessageKey } from '@linedesk/i18n'
import { fetchQuery, useQuery } from '../cachedQuery.ts'
import { i18n } from '../i18n/index.tsx'
import { PARTNERS_QUERY } from '../session.ts'
import { callAction } from '../settings/settings-api.ts'

/** `#partner` and `#partner/<section>`: the partner area. */
export const isPartnerHash = (hash: string) => hash === '#partner' || hash.startsWith('#partner/')

const INVITE_PREFIX = '#partner-invite='
/** The token of a partner team invitation link (`#partner-invite=<token>`), else null. */
export const partnerInviteToken = (hash: string) =>
  hash.startsWith(INVITE_PREFIX) ? decodeURIComponent(hash.slice(INVITE_PREFIX.length)) || null : null

async function loadMyPartners(): Promise<MyPartner[]> {
  const res = await fetch('/v1/me', { credentials: 'include' })
  if (!res.ok) return []
  return ((await res.json()) as { partners?: MyPartner[] }).partners ?? []
}

/**
 * Opens a partner's area: here, or on a white-label partner's own address (`areaOrigin`, S5), where it does not open, at
 * the install's own address in a new tab.
 */
export function openPartnerArea(partner: Pick<MyPartner, 'areaOrigin'>) {
  if (partner.areaOrigin) window.open(new URL('/#partner', partner.areaOrigin).toString(), '_blank', 'noopener')
  else window.location.hash = '#partner'
}

/** The person's partners: known with the session (session.ts primes them from /v1/me), checked again in the background. */
export const useMyPartners = (): MyPartner[] => useQuery(PARTNERS_QUERY, loadMyPartners).data ?? []
export const refreshMyPartners = () => fetchQuery(PARTNERS_QUERY, loadMyPartners)

export const PARTNER_QUERY = (partnerId: string) => `partner.${partnerId}`
export const loadPartner = (partnerId: string) => callAction<PartnerData>('partner.get', { partnerId })

/** Partner › Clients' rows: how each client is doing this period (partner.listClients). */
export const PARTNER_CLIENTS_QUERY = (partnerId: string) => `partner.${partnerId}.clients`
export const loadClients = (partnerId: string) => callAction<PartnerClientList>('partner.listClients', { partnerId })

/** A refusal the page words itself (PARTNER_CODES), a 403 as "not allowed", else the server's own text. */
// i18n-dynamic: team.partner.error.*
export function partnerErrorText(err: unknown): string {
  const { t } = i18n()
  const code = (err as { code?: string }).code
  if (code && (PARTNER_CODES as readonly string[]).includes(code))
    return t(`team.partner.error.${code}` as MessageKey, { limit: UNPAID_PARTNER_CLIENTS })
  if (code === 'forbidden') return t('team.partner.error.forbidden')
  return err instanceof Error ? err.message : String(err)
}
