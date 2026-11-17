// Workspace settings › Billing › Voices and models (Linedesk Cloud; moved here from General on 2026-11-17, they decide
// what the workspace pays): Allow Premium voices and models (workspace.setAllowPremium) and Allow Ultra
// (workspace.setAllowUltra). Only on an install that bills usage (`usageLevels`). Who may switch them comes from the
// server (`allowSwitch`): whoever manages the bill (its owner, or an owner or admin of the only workspace it pays for),
// or the workspace's owner where there is no bill; a white-label client's partner decides for it. Off moves the
// assistants using them back (Standard, or the three stages for Ultra).
import { type AllowPremiumData, type AllowUltraData, USAGE_CENTS_PER_MINUTE } from '@linedesk/actions'
import type { MessageKey } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { refreshQuery } from '../cachedQuery.ts'
import { rejectionText } from '../shell/rejections.ts'
import { Section, SwitchRow } from './fields.tsx'
import { pricePerMinute } from './levelModel.ts'
import { useReadOnlyNote } from './readOnly.ts'
import { patchWorkspaceSettings, useWorkspaceSettings, useWriteAction } from './settings-api.ts'

type Props = {
  /** Owners and admins in their own session; false during support access (read-only). */
  canEdit: boolean
  isOwner: boolean
  /** The workspace is on a bill (`me.workspace.billingState`): who may switch without one is its owner only. */
  onBill: boolean
  toast: (text: string) => void
}

/** The Voices and models card of Billing; nothing on an install that does not bill usage. */
export function PaidLevels(props: Props) {
  const t = useT()
  const settings = useWorkspaceSettings().data
  if (!settings?.usageLevels) return null
  return (
    <Section
      id="billing-levels"
      title={t('settings.billing.levels.title')}
      // No prices where nobody is charged: a partner's client, or a workspace on no bill (its calls are not billed).
      description={settings.partnerManaged || !props.onBill ? undefined : t('settings.billing.levels.description')}
    >
      <AllowLevel level="premium" {...props} />
      <AllowLevel level="ultra" {...props} />
    </Section>
  )
}

const ACTION = { premium: 'workspace.setAllowPremium', ultra: 'workspace.setAllowUltra' } as const

/** One Allow switch: Premium voices and models, or Ultra. */
function AllowLevel({ level, canEdit, isOwner, onBill, toast }: Props & { level: 'premium' | 'ultra' }) {
  const t = useT()
  const readOnly = useReadOnlyNote()
  const write = useWriteAction()
  const settings = useWorkspaceSettings().data
  const [busy, setBusy] = useState(false)
  if (!settings) return null
  const cents = settings.usageCentsPerMinute ?? USAGE_CENTS_PER_MINUTE
  const prices = {
    standard: pricePerMinute(cents.standard),
    premium: pricePerMinute(cents.premium),
    ultra: pricePerMinute(cents.ultra),
  }
  const isOn = level === 'premium' ? settings.allowPremium : settings.allowUltra
  // Who may switch it, from the server; an older API: the owner.
  const may = mayChange(settings.allowSwitch, isOn, isOwner && canEdit)
  // i18n-dynamic: settings.general.premium.* settings.general.ultra.*
  const key = (name: string) => `settings.general.${level}.${name}` as MessageKey

  async function change(on: boolean) {
    setBusy(true)
    try {
      if (level === 'premium') {
        const data = await write<AllowPremiumData>(ACTION.premium, { on })
        patchWorkspaceSettings({ allowPremium: data.on })
        toast(
          data.on
            ? t('settings.general.premium.on')
            : t('settings.general.premium.off', { count: data.movedToStandard.length }),
        )
      } else {
        const data = await write<AllowUltraData>(ACTION.ultra, { on })
        patchWorkspaceSettings({ allowUltra: data.on })
        toast(
          data.on
            ? t('settings.general.ultra.on')
            : t('settings.general.ultra.off', { count: data.movedOffUltra.length }),
        )
      }
      void refreshQuery('voice.options')
    } catch (e) {
      toast(rejectionText(ACTION[level], (e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  // A white-label client: its partner decides, and its people see no prices (docs/white-label.md).
  const description = settings.partnerManaged
    ? t(key('partner'))
    : !canEdit
      ? readOnly
      : !onBill
        ? t(key(may ? 'helpNoBill' : 'ownerOnlyNoBill'))
        : may
          ? t(key('help'), prices)
          : t(key('billOwnerOnly'), prices)
  const tip =
    settings.partnerManaged || may || !canEdit
      ? undefined
      : t(onBill ? 'settings.general.allowSwitchTip' : 'settings.general.allowSwitchTipNoBill')
  return (
    <SwitchRow
      title={t(key('label'))}
      description={description}
      on={isOn}
      onChange={on => void change(on)}
      disabled={settings.partnerManaged || !may || busy}
      tip={tip}
    />
  )
}

/** Whether the caller may flip an Allow switch now: on needs `allowSwitch.on`, off `allowSwitch.off`. */
function mayChange(allowSwitch: { on: boolean; off: boolean } | undefined, isOn: boolean, fallback: boolean) {
  if (!allowSwitch) return fallback
  return isOn ? allowSwitch.off : allowSwitch.on
}
