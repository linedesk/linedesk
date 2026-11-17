// Partner › Clients › Settings… (white-label slice S3, LIN-454): a client's monthly usage limit, set by anyone on the
// partner team, and Allow Premium and Allow Ultra, which only the partner's owner switches (LIN-440: the partner pays,
// so it decides; the client's own owner cannot). The limit is in dollars on the partner bill's ledger.
import { CLIENT_USAGE_LIMIT_MAX_USD, CLIENT_USAGE_LIMIT_MIN_USD, type PartnerClientRow } from '@linedesk/actions'
import { useFormat, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { SwitchRow } from '../settings/fields.tsx'
import { callAction } from '../settings/settings-api.ts'
import { Dialog, FormField, Input } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { partnerErrorText } from './partner-api.ts'

type Props = {
  partnerId: string
  client: PartnerClientRow
  /** The partner's owner: Allow Premium and Allow Ultra are theirs to switch. */
  owner: boolean
  onClose: () => void
  /** After a change: the list as the server has it now, and a line for the toast. */
  onSaved: (message: string) => Promise<void> | void
}

/** The typed limit: null for an empty field (no limit), NaN for anything that is not an allowed amount. */
export function parseLimit(typed: string): number | null {
  const text = typed.trim().replace(/^\$/, '').replaceAll(',', '')
  if (!text) return null
  const value = Number(text)
  if (!Number.isFinite(value) || value < CLIENT_USAGE_LIMIT_MIN_USD || value > CLIENT_USAGE_LIMIT_MAX_USD)
    return Number.NaN
  return Math.round(value * 100) / 100
}

export function ClientSettingsDialog({ partnerId, client, owner, onClose, onSaved }: Props) {
  const t = useT()
  const format = useFormat()
  const [limit, setLimit] = useState(client.limitCents === null ? '' : String(client.limitCents / 100))
  const [premium, setPremium] = useState(client.allowPremium)
  const [ultra, setUltra] = useState(client.allowUltra)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const parsed = parseLimit(limit)
  const invalid = Number.isNaN(parsed)
  const cents = invalid ? null : parsed === null ? null : Math.round(parsed * 100)
  const limitChanged = !invalid && cents !== client.limitCents
  // Raising or removing the limit is the partner's owner's; an admin may lower it or set one (review of #1113, L-1).
  const loosens = limitChanged && client.limitCents !== null && (cents === null || cents > client.limitCents)
  const ownerOnly = loosens && !owner
  const changed = limitChanged || premium !== client.allowPremium || ultra !== client.allowUltra

  async function save() {
    if (busy || invalid || ownerOnly || !changed) return
    setBusy(true)
    setProblem(null)
    try {
      const base = { partnerId, workspaceId: client.id }
      if (limitChanged) await callAction('partner.setClientUsageLimit', { ...base, limitUsd: parsed })
      if (premium !== client.allowPremium)
        await callAction('partner.setClientAllow', { ...base, level: 'premium', on: premium })
      if (ultra !== client.allowUltra)
        await callAction('partner.setClientAllow', { ...base, level: 'ultra', on: ultra })
      await onSaved(t('team.partner.clients.saved', { name: client.name }))
      onClose()
    } catch (err) {
      setProblem(partnerErrorText(err))
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={t('team.partner.clients.settingsTitle', { name: client.name })}
      size="sm"
      onClose={busy ? () => {} : onClose}
      onSubmit={e => {
        e.preventDefault()
        void save()
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.action.cancel')}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={invalid || ownerOnly || !changed}>
            {t('team.partner.clients.save')}
          </Button>
        </>
      }
    >
      <FormField
        id="partner-client-limit"
        label={t('team.partner.clients.limit.label')}
        description={owner ? t('team.partner.clients.limit.help') : t('team.partner.clients.limit.helpAdmin')}
        error={
          ownerOnly
            ? t('team.partner.clients.limit.ownerOnly')
            : invalid
              ? t('team.partner.clients.limit.invalid', {
                  min: format.currency(CLIENT_USAGE_LIMIT_MIN_USD, 'USD', { maximumFractionDigits: 0 }),
                  max: format.currency(CLIENT_USAGE_LIMIT_MAX_USD, 'USD', { maximumFractionDigits: 0 }),
                })
              : null
        }
      >
        <Input
          id="partner-client-limit"
          inputMode="decimal"
          value={limit}
          autoComplete="off"
          placeholder={t('team.partner.clients.noLimit')}
          onChange={e => setLimit(e.target.value)}
        />
      </FormField>
      <SwitchRow
        title={t('team.partner.clients.allowPremium')}
        description={t('team.partner.clients.allowPremiumHelp')}
        on={premium}
        onChange={setPremium}
        disabled={!owner || busy}
      />
      <SwitchRow
        title={t('team.partner.clients.allowUltra')}
        description={t('team.partner.clients.allowUltraHelp')}
        on={ultra}
        onChange={setUltra}
        disabled={!owner || busy}
      />
      {!owner && <p className="help">{t('team.partner.clients.allowOwnerOnly')}</p>}
      {problem && (
        <Note tone="danger" role="alert">
          {problem}
        </Note>
      )}
    </Dialog>
  )
}
