// Server admin › Providers › Billing (docs/billing.md §7): the install's billing switch below the Stripe provider.
// Billing runs only when Stripe has both keys and this switch is on (off by default), so a self-hosted install with
// keys stored still bills nobody. A dev install (LINEDESK_MODE=dev) refuses live keys; the line under the switch
// says which mode the stored key is in, or that billing is paused because the ledger's database guards are not intact.
import type { BillingEnabledData } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { useEffect, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Switch } from '../ui/controls.tsx'
import { useSupportAccess } from '../supportAccess.ts'
import { Loading, Skeleton } from '../ui/LoadStates.tsx'
import { type AdminData, runAdmin } from './api.ts'

const BILLING = 'admin.billingEnabled'
const load = async () => (await runAdmin('billingEnabled.get', {})) as BillingEnabledData

/** The line under the switch: what is missing, or which mode the key is in. */
function stateLine(data: BillingEnabledData): MessageKey {
  if (!data.connected) return msg('admin.billing.notConnected')
  if (data.mode === 'live' && !data.liveAllowed) return msg('admin.billing.liveRefused')
  if (!data.guardsOk) return msg('admin.billing.guardsMissing')
  if (data.mode === 'live') return msg('admin.billing.liveMode')
  return msg('admin.billing.testMode')
}

/** `data`: the admin data, read again after a dialog saved or removed a key, so the state here is read again too. */
export function BillingSwitch({ data: admin }: { data: AdminData }) {
  const t = useT()
  // Server admin is not open during support access, and the server refuses billing to it: read-only, nothing loaded,
  // like every setting then (settings/readOnly.ts).
  const supportAccess = useSupportAccess()
  const query = useQuery(supportAccess ? null : BILLING, load)
  const [problem, setProblem] = useState<string | null>(null)
  const { reload } = query
  useEffect(() => {
    void admin
    if (!supportAccess) void reload()
  }, [admin, reload, supportAccess])
  const data = query.data
  const on = data?.on ?? false

  async function change(next: boolean) {
    if (!data || supportAccess) return
    setProblem(null)
    setQueryData<BillingEnabledData | undefined>(BILLING, { ...data, on: next })
    try {
      const saved = (await runAdmin('billingEnabled.set', { on: next })) as BillingEnabledData
      setQueryData<BillingEnabledData | undefined>(BILLING, saved)
    } catch (e) {
      setQueryData<BillingEnabledData | undefined>(BILLING, data)
      setProblem(e instanceof Error ? e.message : t('admin.billing.failed'))
    }
  }

  const blocked = !!data && (!data.connected || (data.mode === 'live' && !data.liveAllowed))
  return (
    <div className="swrow">
      <div>
        <b>{t('admin.billing.switch')}</b>
        <span className="help">
          {supportAccess
            ? t('settings.readOnly.supportAccess')
            : data
              ? t(stateLine(data))
              : t('admin.billing.help')}
        </span>
        {problem && (
          <span className="k-field-msg" role="alert">
            {problem}
          </span>
        )}
      </div>
      <Loading
        what={t('admin.billing.switch')}
        loading={!data && !supportAccess}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<Skeleton width={34} height={20} className="sk-round" />}
      >
        <Switch
          on={on}
          onChange={v => void change(v)}
          label={t('admin.billing.switch')}
          // Turning it off always works; on needs usable keys.
          disabled={supportAccess || !data || (!on && blocked)}
        />
      </Loading>
    </div>
  )
}
