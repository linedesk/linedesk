// The embedded page of the install's Shopify app (GET /shopify/app, shopify-embedded.ts): what a store's admin shows
// in the app's frame. App Bridge's script comes first, before any other (App Store rule 2.2). The page's own script
// (with the response's CSP nonce) asks the API with App Bridge's session token and shows the store linked to a
// workspace ("Open Linedesk") or not yet ("Connect this store to Linedesk", a new tab with a single-use link, for the
// store's owner only; another staff member reads that only the owner connects the store); it
// asks again every few seconds while not linked, and when the page gets the focus back. No cookie, no browser storage.
// Every word comes from here in the reader's language; names (the store, the workspace) are filled in by the script
// as text, never as HTML.
import { getT } from '@linedesk/i18n/server'
import { emailBrandName } from '../email-brand.ts'
import type { EmailLocale } from './templates.ts'

const htmlEscape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
/** JSON inside a script element: nothing in it can end the element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

/** Placeholders the script replaces with the store's and the workspace's names. */
const SHOP = '\u0001shop\u0001'
const WORKSPACE = '\u0001workspace\u0001'

const STYLE = `
:root{color-scheme:light;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a1a}
body{margin:0;background:#f6f6f7}
main{max-width:560px;margin:32px auto;padding:24px;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
h1{font-size:18px;margin:0 0 8px}
p{margin:0 0 16px;color:#4a4a4a}
.hint{font-size:13px;color:#6d6d6d;margin:16px 0 0}
.btn{display:inline-block;padding:8px 14px;border-radius:8px;background:#111;color:#fff;text-decoration:none;font-weight:600}
.btn:hover{background:#333}
.btn:focus-visible{outline:2px solid #111;outline-offset:2px}
[hidden]{display:none!important}
`

/**
 * The client script: reads the words from the `texts` element, asks `sessionPath` with App Bridge's session token
 * (`link: true` for a new link when the page opens and before the last one runs out), and shows one state.
 */
const SCRIPT = `
(() => {
  const texts = JSON.parse(document.getElementById('texts').textContent)
  const config = JSON.parse(document.getElementById('config').textContent)
  const byId = id => document.getElementById(id)
  const fill = (text, values) => text.split(${JSON.stringify(SHOP)}).join(values.shop || '').split(${JSON.stringify(WORKSPACE)}).join(values.workspace || '')
  const LINK_FRESH_MS = 10 * 60 * 1000
  const POLL_MS = 4000
  let linkUrl = null
  let linkAt = 0
  let linked = false
  let ownerOnly = false
  let timer = null
  function show(state, values) {
    for (const id of ['loading', 'failed', 'link', 'linked', 'owner-only']) byId(id).hidden = id !== state
    if (state === 'link') {
      byId('link-title').textContent = fill(texts.linkTitle, values)
      byId('link-button').href = linkUrl || '#'
    }
    if (state === 'linked') {
      byId('linked-title').textContent = fill(texts.linkedTitle, values)
      byId('linked-text').textContent = fill(texts.linkedText, values)
      byId('open-button').title = fill(texts.openTip, values)
      byId('open-button').href = values.openUrl
    }
  }
  async function ask(link) {
    const token = await shopify.idToken()
    const res = await fetch(config.sessionPath, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ link }),
    })
    if (!res.ok) throw new Error(String(res.status))
    return (await res.json()).data
  }
  async function refresh() {
    const link = !linked && !ownerOnly && Date.now() - linkAt > LINK_FRESH_MS
    try {
      const status = await ask(link)
      if (status.linkUrl) {
        linkUrl = status.linkUrl
        linkAt = Date.now()
      }
      linked = Boolean(status.workspace)
      if (link) ownerOnly = Boolean(status.ownerOnly)
      const values = { shop: status.shopName, workspace: status.workspace ? status.workspace.name : '', openUrl: status.openUrl }
      if (linked) show('linked', values)
      else if (ownerOnly) show('owner-only', values)
      else if (linkUrl) show('link', values)
      else show('failed', values)
    } catch {
      if (!linked && !linkUrl) show('failed', {})
    }
    schedule()
  }
  function schedule() {
    clearTimeout(timer)
    if (!linked && document.visibilityState === 'visible') timer = setTimeout(refresh, POLL_MS)
  }
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? refresh() : clearTimeout(timer)))
  refresh()
})()
`

type Page = { locale: EmailLocale; nonce: string } & (
  | { clientId: string; sessionPath: string }
  | { clientId: null; sessionPath?: undefined }
)

/**
 * The embedded page. Without `clientId` (the app is not set up on this server, or Shopify named no store): one line
 * saying so, and no script at all.
 */
export function shopifyEmbeddedPage(page: Page): string {
  const { t, locale: lang } = getT(page.locale)
  const brand = emailBrandName()
  const title = htmlEscape(brand)
  const head = (scripts: string) =>
    `<!doctype html><html lang="${htmlEscape(lang)}"><head><meta charset="utf-8">${scripts}<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style nonce="${htmlEscape(page.nonce)}">${STYLE}</style></head>`
  if (!page.clientId)
    return `${head('')}<body><main><h1>${title}</h1><p>${htmlEscape(t('email.shopifyApp.notSetUp', { brand }))}</p></main></body></html>`
  // App Bridge first: Shopify's rule, and it must load before anything that uses `shopify`.
  const appBridge = `<meta name="shopify-api-key" content="${htmlEscape(page.clientId)}"><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js" data-api-key="${htmlEscape(page.clientId)}"></script>`
  const texts = {
    linkTitle: t('email.shopifyApp.link.title', { shop: SHOP, brand }),
    linkedTitle: t('email.shopifyApp.linked.title', { workspace: WORKSPACE }),
    linkedText: t('email.shopifyApp.linked.text', { workspace: WORKSPACE, brand }),
    openTip: t('email.shopifyApp.linked.openTip', { workspace: WORKSPACE, brand }),
  }
  const config = { sessionPath: page.sessionPath }
  const button = (id: string, label: string, tip: string, href = '#') =>
    `<a class="btn" id="${id}" href="${htmlEscape(href)}" target="_blank" rel="noopener" title="${htmlEscape(tip)}">${htmlEscape(label)}</a>`
  const body = [
    `<section id="loading" aria-busy="true"><p>${htmlEscape(t('email.shopifyApp.loading'))}</p></section>`,
    `<section id="failed" hidden><h1>${title}</h1><p role="alert">${htmlEscape(t('email.shopifyApp.failed', { brand }))}</p></section>`,
    `<section id="link" hidden><h1 id="link-title"></h1><p>${htmlEscape(t('email.shopifyApp.link.text', { brand }))}</p>${button('link-button', t('email.shopifyApp.link.button', { brand }), t('email.shopifyApp.link.buttonTip', { brand }))}<p class="hint">${htmlEscape(t('email.shopifyApp.link.waiting'))}</p></section>`,
    `<section id="owner-only" hidden><h1>${title}</h1><p>${htmlEscape(t('email.shopifyApp.ownerOnly', { brand }))}</p></section>`,
    `<section id="linked" hidden><h1 id="linked-title"></h1><p id="linked-text"></p>${button('open-button', t('email.shopifyApp.linked.open', { brand }), '')}</section>`,
  ].join('')
  const nonce = htmlEscape(page.nonce)
  return `${head(appBridge)}<body><main>${body}</main><script type="application/json" id="texts">${scriptJson(texts)}</script><script type="application/json" id="config">${scriptJson(config)}</script><script nonce="${nonce}">${SCRIPT}</script></body></html>`
}
