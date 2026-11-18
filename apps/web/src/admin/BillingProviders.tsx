// Server admin › Billing's providers (LIN-556), moved here from Server admin › Providers: Billing › Stripe shows Stripe
// with the billing switch below it (the Billing group's panel, ProviderGroup), Billing › Sign-up the bot check
// (Cloudflare Turnstile) that guards the sign-up page. The same rows and dialogs as on Providers, opened in place;
// the group's status is the one the overview's card shows (useProviderStatus, read once in AdminMode).
import { type ProviderName, providerCategoryLabel } from '@linedesk/actions'
import { useState } from 'react'
import { i18n } from '../i18n/index.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import type { AdminData } from './api.ts'
import type { Notify } from './notify.ts'
import { ProviderGroup, ProviderList } from './ProviderGroup.tsx'
import { listsOfGroup } from './providerList.ts'
import type { ProviderStatusState } from './providerStatus.ts'
import { ProviderDialogFor } from './Providers.tsx'

export type BillingProvidersProps = {
  /** The admin data (null until it is read) and the providers' status, as AdminMode holds them for every page. */
  data: AdminData | null
  status: ProviderStatusState
  error: string | null
  reload: () => Promise<void>
  notify: Notify
}

/** `part`: Stripe and the billing switch, or the bot check. */
export function BillingProviders({
  part,
  data,
  status,
  error,
  reload,
  notify,
}: BillingProvidersProps & { part: 'billing' | 'bot_check' }) {
  const [open, setOpen] = useState<ProviderName | null>(null)
  const group = status.status?.groups.find(g => g.id === 'billing')
  const lines = status.status?.lines
  const label = providerCategoryLabel(part, i18n())
  const list = listsOfGroup('billing').find(l => l.category === part)
  return (
    <>
      <Loading
        what={label}
        loading={!data || !group || !lines}
        error={error}
        onRetry={() => void reload()}
        skeleton={<SkeletonRows rows={1} columns={2} className="adm-sk-rows" />}
      >
        {data &&
          group &&
          lines &&
          (part === 'billing' ? (
            <ProviderGroup
              group={group}
              data={data}
              lines={lines}
              health={status.health}
              onOpen={setOpen}
              onOneKey={reload}
              embedded
              only="billing"
            />
          ) : (
            list && (
              <section className="adm-provcat" aria-label={label}>
                <h2>{label}</h2>
                <ProviderList
                  title={null}
                  category={part}
                  providers={list.providers}
                  data={data}
                  lines={lines}
                  onOpen={setOpen}
                />
              </section>
            )
          ))}
      </Loading>
      {open && data && (
        <ProviderDialogFor
          name={open}
          data={data}
          status={status}
          reload={reload}
          notify={notify}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}
