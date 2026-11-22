// Server admin › Overview: the Shopify stores waiting for their own app (LIN-719, shopify-setup.ts on the API). Read
// only: the install's team (or its setup agent) makes each store's custom app and hands over its keys (shopifySetup.ready), or marks the
// request failed. Shown only while there is a request.
import type { ShopifySetupListData, ShopifySetupListItem } from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useFormat, useT } from '@linedesk/i18n/react'
import { useQuery } from '../cachedQuery.ts'
import { Badge } from '../ui/kit.tsx'
import { runAdmin } from './api.ts'

const load = async () => (await runAdmin('shopifySetup.list', {})) as ShopifySetupListData

const STATUS: Record<Exclude<ShopifySetupListItem['status'], 'connected'>, MessageKey> = {
  requested: msg('admin.shopifySetups.status.requested'),
  ready: msg('admin.shopifySetups.status.ready'),
  failed: msg('admin.shopifySetups.status.failed'),
}

export function ShopifySetups() {
  const t = useT()
  const format = useFormat()
  const query = useQuery('admin.shopifySetups', load)
  const requests = query.data?.requests ?? []
  if (!requests.length) return null
  const title = t('admin.shopifySetups.title')
  return (
    <section className="adm-card" aria-label={title}>
      <div className="adm-card-head">
        <div>
          <h2>{title}</h2>
          <p className="help">{t('admin.shopifySetups.note')}</p>
        </div>
      </div>
      <div className="adm-scroll">
        <table className="adm-table">
          <thead>
            <tr>
              <th scope="col">{t('admin.shopifySetups.store')}</th>
              <th scope="col">{t('admin.shopifySetups.workspace')}</th>
              <th scope="col">{t('admin.shopifySetups.by')}</th>
              <th scope="col">{t('admin.shopifySetups.asked')}</th>
              <th scope="col">{t('admin.shopifySetups.statusTitle')}</th>
            </tr>
          </thead>
          <tbody>
            {requests.map(r => (
              <tr key={r.id}>
                <th scope="row">{r.shop}</th>
                <td>{r.workspaceName || r.workspaceId}</td>
                <td>{r.requestedBy ?? ''}</td>
                <td>{format.dateTime(new Date(r.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}</td>
                <td>
                  {r.status !== 'connected' && (
                    <Badge
                      tone={r.status === 'failed' ? 'danger' : 'outline'}
                      title={r.failure ? t('admin.shopifySetups.failureTip', { code: r.failure }) : undefined}
                    >
                      {t(STATUS[r.status])}
                    </Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
