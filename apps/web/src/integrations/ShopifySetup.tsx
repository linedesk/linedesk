// Integrations › Shopify before the store is connected (LIN-719). Until the install's public Shopify app is approved,
// a store connects through a custom app made for it alone: the member asks with the store's address (Request), sees
// that the store is being set up, gets Shopify's install link when it is ready (by email and here), and Shopify's open
// of the installed app brings them back with `connect=<shop>` in the hash, which connects that store at once. With the
// workspace's own app or an approved public app, Connect opens Shopify's consent page as for every app; with the public
// app listed in Shopify's App Store, Connect opens its listing instead (the store installs it there).
import type { ShopifySetupRequest, ShopifySetupStatusData } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { setQueryData, useQuery } from '../cachedQuery.ts'
import { Field } from '../settings/fields.tsx'
import { callAction, readAction } from '../settings/settings-api.ts'
import { Dialog, Input } from '../ui/form.tsx'
import { brandName } from '../brand.ts'
import { Button, Note } from '../ui/kit.tsx'
import { nameKey } from './catalog.ts'

export const SHOPIFY_SETUP = 'shopify.setupStatus'
const loadSetup = () => readAction<ShopifySetupStatusData>('shopify.setupStatus')

/** The store the installed app opened with (`#integrations/shopify?connect=<shop>`), or null. */
export function shopToConnect(hash: string): string | null {
  const query = hash.split('?')[1]
  if (!query) return null
  const shop = new URLSearchParams(query).get('connect')?.trim().toLowerCase()
  return shop && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null
}

/** The hash without `connect`: a reload or Back does not connect again. */
export function withoutConnect(hash: string): string {
  const [path, query] = hash.split('?')
  if (!query) return hash
  const params = new URLSearchParams(query)
  params.delete('connect')
  const rest = params.toString()
  return rest ? `${path}?${rest}` : path!
}

/** The `code` an action's rejection carries (settings-api.ts), which the page words itself. */
const codeOf = (e: unknown) => (e as { code?: unknown }).code

type Props = {
  canEdit: boolean
  toast: (text: string) => void
  /** Opens Shopify's consent page (ConnectedApp's useConnect); `shop` names the store. */
  connect: (shop?: string) => void
  opening: boolean
  /** The store the installed app opened with: connected at once where Connect works. */
  openShop: string | null
}

export function ShopifyNotConnected({ canEdit, toast, connect, opening, openShop }: Props) {
  const t = useT()
  const setup = useQuery(SHOPIFY_SETUP, loadSetup)
  const [asking, setAsking] = useState(false)
  const started = useRef(false)
  const data = setup.data
  // Back from the store's install: connect that store now (Shopify answers at once, the app is installed).
  useEffect(() => {
    // Only the store this workspace asked for and that is ready: a hand-made link connects nothing by itself.
    const asked = data?.request
    if (!openShop || !canEdit || started.current || data?.way !== 'connect') return
    if (asked?.shop !== openShop || asked.status !== 'ready') return
    started.current = true
    connect(openShop)
  }, [openShop, canEdit, data?.way, data?.request, connect])

  if (!data)
    return (
      <p className="help" aria-busy="true">
        {t('settings.integrations.app.shopify.request.loading')}
      </p>
    )
  const request = data.request
  const name = t(nameKey('shopify'))
  const dialog = asking && (
    <RequestDialog
      initial={request?.shop ?? ''}
      onClose={() => setAsking(false)}
      onSent={next => {
        setQueryData(SHOPIFY_SETUP, next)
        setAsking(false)
        toast(t('settings.integrations.app.shopify.request.sent'))
      }}
    />
  )
  if (request && request.status !== 'connected')
    return (
      <>
        <RequestStatus
          request={request}
          canEdit={canEdit}
          way={data.way}
          connect={connect}
          opening={opening}
          onAskAgain={() => setAsking(true)}
        />
        {dialog}
      </>
    )
  if (!canEdit) return <p className="help">{t('settings.integrations.app.onlyAdmins', { name })}</p>
  // The public app is listed in Shopify's App Store: installed from there (never by naming a store here); the app in the
  // store's Shopify admin then links the store to a workspace.
  if (data.way === 'app_store' && data.appStoreUrl)
    return (
      <div className="ig-app-connect">
        <p className="help">{t('settings.integrations.app.shopify.appStore.text', { brand: brandName() })}</p>
        <a
          className="k-btn k-btn-primary k-btn-md"
          href={data.appStoreUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={t('settings.integrations.app.shopify.appStore.buttonTip', { brand: brandName() })}
        >
          <span>{t('settings.integrations.app.shopify.appStore.button')}</span>
        </a>
      </div>
    )
  const direct = data.way === 'connect'
  return (
    <div className="ig-app-connect">
      <p className="help">
        {direct
          ? t('settings.integrations.app.shopify.notConnected')
          : t('settings.integrations.app.shopify.request.notConnected')}
      </p>
      <Button
        variant="primary"
        disabled={opening}
        onClick={() => (direct ? connect() : setAsking(true))}
        title={
          direct
            ? t('settings.integrations.app.connectTip', { name })
            : t('settings.integrations.app.shopify.request.openTip')
        }
      >
        {opening ? t('settings.integrations.app.opening', { name }) : t('settings.integrations.app.connect', { name })}
      </Button>
      {dialog}
    </div>
  )
}

function RequestStatus({
  request,
  canEdit,
  way,
  connect,
  opening,
  onAskAgain,
}: {
  request: ShopifySetupRequest
  canEdit: boolean
  way: ShopifySetupStatusData['way']
  connect: (shop?: string) => void
  opening: boolean
  onAskAgain: () => void
}) {
  const t = useT()
  const shop = request.shop
  const other = canEdit && (
    <Button
      size="sm"
      variant="ghost"
      onClick={onAskAgain}
      title={t('settings.integrations.app.shopify.request.otherTip')}
    >
      {t('settings.integrations.app.shopify.request.other')}
    </Button>
  )
  if (request.status === 'ready')
    return (
      <Note
        tone="info"
        title={t('settings.integrations.app.shopify.request.ready.title', { shop })}
        action={
          canEdit && (
            <>
              {request.installUrl && (
                <a
                  className="k-btn k-btn-primary k-btn-sm"
                  href={request.installUrl}
                  title={t('settings.integrations.app.shopify.request.ready.installTip', { shop })}
                >
                  <span>{t('settings.integrations.app.shopify.request.ready.install')}</span>
                </a>
              )}
              {way === 'connect' && (
                <Button
                  size="sm"
                  disabled={opening}
                  onClick={() => connect(shop)}
                  title={t('settings.integrations.app.shopify.request.ready.connectTip', { shop })}
                >
                  {t('settings.integrations.app.shopify.request.ready.connect')}
                </Button>
              )}
            </>
          )
        }
      >
        {t('settings.integrations.app.shopify.request.ready.text')}
      </Note>
    )
  if (request.status === 'failed')
    return (
      <Note tone="warning" title={t('settings.integrations.app.shopify.request.failed.title', { shop })} action={other}>
        {t('settings.integrations.app.shopify.request.failed.text')}
      </Note>
    )
  return (
    <Note tone="info" title={t('settings.integrations.app.shopify.request.requested.title', { shop })} action={other}>
      {t('settings.integrations.app.shopify.request.requested.text')}
    </Note>
  )
}

function RequestDialog({
  initial,
  onClose,
  onSent,
}: {
  initial: string
  onClose: () => void
  onSent: (data: ShopifySetupStatusData) => void
}) {
  const t = useT()
  const [shop, setShop] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (sending || !shop.trim()) return
    setSending(true)
    setError(null)
    try {
      onSent(await callAction<ShopifySetupStatusData>('shopify.requestSetup', { shop: shop.trim() }))
    } catch (err) {
      setError(
        codeOf(err) === 'shop'
          ? t('settings.integrations.app.error.shop')
          : codeOf(err) === 'too_soon'
            ? t('settings.integrations.app.shopify.request.tooSoon')
            : t('settings.integrations.app.shopify.request.failedSend'),
      )
      setSending(false)
    }
  }
  return (
    <Dialog
      title={t('settings.integrations.app.shopify.request.title')}
      description={t('settings.integrations.app.shopify.request.text')}
      onClose={onClose}
      onSubmit={e => void submit(e)}
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>{t('common.action.cancel')}</Button>
          <Button
            type="submit"
            variant="primary"
            busy={sending}
            disabled={!shop.trim()}
            shortcut={['↵']}
            title={t('settings.integrations.app.shopify.request.submitTip')}
          >
            {t('settings.integrations.app.shopify.request.submit')}
          </Button>
        </>
      }
    >
      <Field
        id="shopify-store"
        label={t('settings.integrations.app.shopify.request.store')}
        help={t('settings.integrations.app.shopify.request.storeHelp')}
        error={error}
      >
        <Input
          id="shopify-store"
          value={shop}
          invalid={Boolean(error)}
          placeholder={t('settings.integrations.app.shopify.request.storePlaceholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={e => setShop(e.target.value)}
        />
      </Field>
    </Dialog>
  )
}
