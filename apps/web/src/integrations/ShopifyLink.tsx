// Linking a store that installed the app from Shopify's App Store (`#shopify/link?t=<token>`): the app's page in the
// store's Shopify admin opens this in a new tab with a single-use link (15 minutes, apps/api/src/shopify-embedded.ts),
// made only for the store's owner. The page names the store by its myshopify.com address and who started the link,
// and warns that it is only for someone who opened it from their own store; Enter confirms only on the focused button.
// Signed out, the sign-in keeps the address and comes back here; the link is also kept in this tab (sessionStorage)
// through a sign-up or a new workspace, and this page opens again once there is a workspace. An owner or admin
// confirms (shopify.linkInstall), and the workspace's Integrations › Shopify opens with the store connected. Another
// workspace: the account menu at the top right.
import {
  isShopifyLinkError,
  SHOPIFY_LINK_HASH,
  type ShopifyLinkData,
  type ShopifyLinkError,
  type ShopifyLinkInfo,
} from '@linedesk/actions'
import { type MessageKey, msg } from '@linedesk/i18n'
import { useT } from '@linedesk/i18n/react'
import { type ReactNode, useEffect, useState } from 'react'
import type { Me } from '../auth.ts'
import { ConfirmEmail } from '../ConfirmEmail.tsx'
import { refreshOnReturn } from '../refreshOnReturn.ts'
import { callAction } from '../settings/settings-api.ts'
import { SignedInAuthPage, WaitLine } from '../shell/SignedInAuthPage.tsx'
import { AuthError } from '../ui/AuthError.tsx'
import { Button } from '../ui/kit.tsx'

const STASH = 'linedesk.shopifyLink'
/** As long as the link itself is good (SHOPIFY_LINK_TTL_MS on the API). */
const STASH_MS = 15 * 60_000
const TOKEN = /^[A-Za-z0-9_-]{32,100}$/

export const isShopifyLinkHash = (hash: string) =>
  hash === SHOPIFY_LINK_HASH || hash.startsWith(`${SHOPIFY_LINK_HASH}?`)

/** The link's token in the address, or null. */
export function shopifyLinkToken(hash: string): string | null {
  if (!isShopifyLinkHash(hash)) return null
  const token = new URLSearchParams(hash.slice(SHOPIFY_LINK_HASH.length + 1)).get('t')
  return token && TOKEN.test(token) ? token : null
}

/** Keeps the link in this tab, so a sign-up or a new workspace on the way does not lose it. */
export function rememberShopifyLink(token: string, now = Date.now(), storage: Storage = sessionStorage) {
  try {
    storage.setItem(STASH, JSON.stringify({ token, at: now }))
  } catch {}
}

/** The link this tab kept, while it can still be good; null otherwise. */
export function pendingShopifyLink(now = Date.now(), storage: Storage = sessionStorage): string | null {
  try {
    const kept = JSON.parse(storage.getItem(STASH) ?? 'null') as { token?: unknown; at?: unknown } | null
    if (typeof kept?.token !== 'string' || typeof kept.at !== 'number' || !TOKEN.test(kept.token)) return null
    return now - kept.at < STASH_MS ? kept.token : null
  } catch {
    return null
  }
}

export function forgetShopifyLink(storage: Storage = sessionStorage) {
  try {
    storage.removeItem(STASH)
  } catch {}
}

/** The address of the link page for a kept link. */
export const shopifyLinkHash = (token: string) => `${SHOPIFY_LINK_HASH}?t=${token}`

const ERROR_TEXT: Record<ShopifyLinkError, MessageKey> = {
  link_invalid: msg('settings.integrations.shopifyLink.error.linkInvalid'),
  link_expired: msg('settings.integrations.shopifyLink.error.linkExpired'),
  not_installed: msg('settings.integrations.shopifyLink.error.notInstalled'),
  other_store: msg('settings.integrations.shopifyLink.error.otherStore'),
  linked_elsewhere: msg('settings.integrations.shopifyLink.error.linkedElsewhere'),
  own_app: msg('settings.integrations.shopifyLink.error.ownApp'),
  scope: msg('settings.integrations.shopifyLink.error.scope'),
  no_secrets_key: msg('settings.integrations.shopifyLink.error.noSecretsKey'),
}

const codeOf = (e: unknown) => (e as { code?: unknown }).code
/** The words for a refusal: its code's, else the general one. */
const errorKey = (e: unknown): MessageKey => {
  const code = codeOf(e)
  return isShopifyLinkError(code) ? ERROR_TEXT[code] : msg('settings.integrations.shopifyLink.failed')
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <SignedInAuthPage>
      <div className="auth-card shopify-link">
        <h1>{title}</h1>
        {children}
      </div>
    </SignedInAuthPage>
  )
}

type Props = {
  me: Me
  /** Leaves the page for the app (the link is forgotten unless `keep`: a workspace is made first). */
  onLeave: (keep?: boolean) => void
}

export function ShopifyLink({ me, onLeave }: Props) {
  const t = useT()
  const [token] = useState(() => shopifyLinkToken(window.location.hash))
  const [info, setInfo] = useState<ShopifyLinkInfo | null>(null)
  const [problem, setProblem] = useState<MessageKey | null>(token ? null : ERROR_TEXT.link_invalid)
  const [error, setError] = useState<MessageKey | null>(null)
  const [linking, setLinking] = useState(false)
  // An account whose address is not confirmed yet confirms it here first (the API refuses the link before).
  const [mustConfirm, setMustConfirm] = useState(Boolean(me.emailUnconfirmed))
  const workspace = me.workspace
  const workspaceId = workspace?.id

  useEffect(() => {
    if (!token || !workspaceId) return
    rememberShopifyLink(token)
    callAction<ShopifyLinkInfo>('shopify.describeLink', { token }).then(setInfo, e => setProblem(errorKey(e)))
  }, [token, workspaceId])

  const leave = () => {
    forgetShopifyLink()
    onLeave()
  }
  const mayLink = me.permissions.includes('settings:write') && !me.impersonation
  const otherStore = info?.connectedShop && info.connectedShop !== info.shop ? info.connectedShop : null
  const ready = Boolean(info && workspace && mayLink && !otherStore && !linking && !mustConfirm)

  async function link() {
    if (!ready || !token) return
    setLinking(true)
    setError(null)
    try {
      await callAction<ShopifyLinkData>('shopify.linkInstall', { token })
      forgetShopifyLink()
      // The connection was written on the server: the page that opens shows it loading, never the state before.
      refreshOnReturn(['app_connections'])
      window.location.hash = '#integrations/shopify'
      window.location.reload()
    } catch (e) {
      if (codeOf(e) === 'EMAIL_NOT_VERIFIED') setMustConfirm(true)
      else setError(errorKey(e))
      setLinking(false)
    }
  }

  // Esc leaves, anywhere on the page. Enter connects only on the focused Connect button (the button's own): never a
  // key press meant for another window, nor one on a page someone else's link opened.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.defaultPrevented) return
      if (e.key === 'Escape') leave()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!workspace)
    return (
      <Card title={t('settings.integrations.shopifyLink.noWorkspaceTitle')}>
        <p>{t('settings.integrations.shopifyLink.noWorkspace')}</p>
        <Button
          variant="primary"
          shortcut={['esc']}
          title={t('common.withKey', { label: t('settings.integrations.shopifyLink.createWorkspaceTip'), key: 'esc' })}
          onClick={() => onLeave(true)}
        >
          {t('settings.integrations.shopifyLink.createWorkspace')}
        </Button>
      </Card>
    )
  if (problem)
    return (
      <Card title={t('settings.integrations.shopifyLink.problemTitle')}>
        <AuthError message={t(problem)} />
        <Button
          shortcut={['esc']}
          title={t('common.withKey', { label: t('settings.integrations.shopifyLink.backTip'), key: 'esc' })}
          onClick={leave}
        >
          {t('settings.integrations.shopifyLink.back')}
        </Button>
      </Card>
    )
  if (!info)
    return (
      <SignedInAuthPage>
        <WaitLine />
      </SignedInAuthPage>
    )
  const shop = info.shopName
  const domain = info.shop
  return (
    // The store's myshopify.com address is the heading: a store's name can look like anyone's, its address cannot.
    <Card title={t('settings.integrations.shopifyLink.title', { shop: domain })}>
      <p className="help">{shop}</p>
      <p>{t('settings.integrations.shopifyLink.text', { shop, workspace: workspace.name })}</p>
      <p className="help">
        {info.startedBy
          ? t('settings.integrations.shopifyLink.startedBy', { email: info.startedBy, domain })
          : t('settings.integrations.shopifyLink.startedIn', { domain })}
      </p>
      <p className="help" role="note">
        {t('settings.integrations.shopifyLink.warning')}
      </p>
      {mustConfirm && (
        <ConfirmEmail why={t('settings.integrations.shopifyLink.confirmWhy')} onDone={() => setMustConfirm(false)} />
      )}
      {!mayLink ? (
        <p className="help" role="note">
          {t('settings.integrations.shopifyLink.notAdmin', { workspace: workspace.name })}
        </p>
      ) : otherStore ? (
        <p className="help" role="note">
          {t('settings.integrations.shopifyLink.otherStore', { workspace: workspace.name, shop: otherStore })}
        </p>
      ) : (
        <p className="help">{t('settings.integrations.shopifyLink.otherWorkspace')}</p>
      )}
      {error && <AuthError message={t(error)} />}
      <div className="auth-form">
        <Button
          variant="primary"
          busy={linking}
          disabled={!ready}
          title={t('settings.integrations.shopifyLink.confirmTip', { shop: domain, workspace: workspace.name })}
          onClick={() => void link()}
        >
          {t('settings.integrations.shopifyLink.confirm', { workspace: workspace.name })}
        </Button>
        <Button
          shortcut={['esc']}
          disabled={linking}
          title={t('common.withKey', { label: t('settings.integrations.shopifyLink.cancelTip'), key: 'esc' })}
          onClick={leave}
        >
          {t('common.action.cancel')}
        </Button>
      </div>
    </Card>
  )
}
