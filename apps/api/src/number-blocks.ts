// Which German areas Linedesk Cloud offers numbers in (docs/numbers-kyc.md, "Only where the carrier holds blocks").
// BNetzA Mitteilung 90/2026 forbids chains of third parties in derived number assignment: a number may be passed on
// only by the carrier the Bundesnetzagentur assigned its block to. The install's carrier for German numbers is Telnyx
// (Telnyx Ireland Ltd, porting ID D451), which holds blocks of its own in about a hundred Ortsnetze; elsewhere it is
// itself a third party of another carrier. So, with this instance setting on, a German number on the install's carrier
// account is requested only in an area where D451 holds blocks, and only a number inside one of those blocks is
// ordered. On by default when the install's carrier is Telnyx; an instance admin turns it off (a self-hosted install
// with its own licence or carrier contract). Never applied to a workspace on its own carrier account.

import type { KycCountry, NumberBlocksData } from '@linedesk/actions'
import { instance_settings, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { type AreaRule, carrierBlocks, EVERY_AREA } from './number-areas.ts'
import { telephonyProvider } from './provider-settings.ts'
import type { CarrierAccount } from './workspace-carrier.ts'

const KEY = 'number_carrier_blocks'
/** The BNetzA porting ID (Portierungskennung) of the carrier German numbers are ordered from: Telnyx Ireland Ltd. */
export const CLOUD_CARRIER_PORTING_ID = 'D451'

let blocks: ReturnType<typeof carrierBlocks> | null = null
const cloudBlocks = () => (blocks ??= carrierBlocks(CLOUD_CARRIER_PORTING_ID))

/** The setting: an instance admin's choice, else on when the install's carrier is Telnyx. */
export async function numberBlocksSetting(tx: Tx): Promise<NumberBlocksData> {
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, KEY))
  const on = row ? row.value === 'on' : (await telephonyProvider(tx).catch(() => null))?.name === 'telnyx'
  return { on, byDefault: !row, portingId: CLOUD_CARRIER_PORTING_ID, areas: cloudBlocks().size }
}

export async function setNumberBlocks(tx: Tx, on: boolean, actorId: string, now: string): Promise<NumberBlocksData> {
  const value = on ? 'on' : 'off'
  await tx
    .insert(instance_settings)
    .values({ key: KEY, value, updated_at: now, updated_by: actorId })
    .onConflictDoUpdate({ target: instance_settings.key, set: { value, updated_at: now, updated_by: actorId } })
  return numberBlocksSetting(tx)
}

/**
 * The areas a request of a workspace can be made in: only the carrier's blocks for a German number on the install's
 * carrier account with the setting on; every area otherwise (another country, the workspace's own carrier account).
 */
export async function areaRuleFor(tx: Tx, country: KycCountry, account: CarrierAccount): Promise<AreaRule> {
  if (country !== 'DE' || account !== 'install') return EVERY_AREA
  return (await numberBlocksSetting(tx)).on ? { blocks: cloudBlocks() } : EVERY_AREA
}
