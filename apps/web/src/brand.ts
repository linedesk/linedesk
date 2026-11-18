// The install's branding (Server admin › Branding; apps/api/src/branding.ts): product name, logo, primary color
// and whether the GitHub star prompt shows. Read before sign-in from GET /v1/branding and kept in
// localStorage, so the next page load shows the right name and logo at once. Applied to the page
// itself here (icons, primary color; Workspace.tsx sets the tab title); components read it with useBrand() or brandName().
// A white-label partner's own screens (its setup and partner area) always show the install's branding, never a partner's
// (Janik, 2026-11-18): they read it with useInstallBrand(), installBrandName() and BrandMark's `install`.
import { type Branding, DEFAULT_BRANDING, readableOn } from '@linedesk/actions'
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'linedesk.branding'
const INSTALL_KEY = 'linedesk.branding.install'

function cached(key: string): Branding | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? { ...DEFAULT_BRANDING, ...(JSON.parse(raw) as Partial<Branding>) } : null
  } catch {
    return null
  }
}

let current: Branding = cached(STORAGE_KEY) ?? DEFAULT_BRANDING
/**
 * The install's own branding: `current` unless a partner's client workspace is open, then the last one the install
 * answered with (every page before sign-in gets it), else Linedesk's.
 */
let install: Branding = cached(INSTALL_KEY) ?? (current.partner ? DEFAULT_BRANDING : current)
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The product name: "Linedesk" unless an instance admin renamed it. */
export const brandName = () => current.name

export const useBrand = (): Branding =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  )

/** The install's name, never a white-label partner's: for a partner's own screens. */
export const installBrandName = () => install.name

/** The install's branding, never a white-label partner's: for a partner's own screens (its setup, the partner area). */
export const useInstallBrand = (): Branding =>
  useSyncExternalStore(
    subscribe,
    () => install,
    () => install,
  )

/** Makes `next` the branding in effect: stored for the next load, applied to the page, shown by every useBrand(). */
export function setBrand(next: Branding) {
  if (typeof document !== 'undefined') renameInTitle(current.name, next.name)
  current = next
  if (!next.partner) install = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    localStorage.setItem(INSTALL_KEY, JSON.stringify(install))
  } catch {
    // Private mode (or no storage at all): the branding is fetched again on the next load.
  }
  if (typeof document !== 'undefined') applyToPage(next)
  for (const listener of listeners) listener()
}

/** Applies the stored branding at once, then the server's. A failed request keeps what is shown. */
export async function loadBrand() {
  applyToPage(current)
  document.title = current.name
  try {
    const res = await fetch('/v1/branding', { headers: { accept: 'application/json' } })
    if (res.ok) setBrand({ ...DEFAULT_BRANDING, ...((await res.json()) as Partial<Branding>) })
  } catch {
    // Offline: the stored branding stays.
  }
}

/** "Inbox · Linedesk" becomes "Inbox · Front Desk" at once; pages that set their own title set it again. */
function renameInTitle(from: string, to: string) {
  const title = document.title
  if (title === from) document.title = to
  else if (title.endsWith(` · ${from}`)) document.title = `${title.slice(0, -from.length)}${to}`
}

const DEFAULT_ICONS = { icon: '/favicon.svg', apple: '/apple-touch-icon.png' }

/** The open workspace's icon (shell/WorkspaceMenu.tsx): the browser tab shows it instead of the install's. */
let workspaceIcon: string | null = null

/** The tab's icon: the open workspace's, else the install logo, else the default mark. */
export const tabIcon = (b: Pick<Branding, 'logoUrl'>, workspace: string | null) =>
  workspace
    ? { href: workspace, type: 'image/png' }
    : b.logoUrl
      ? { href: b.logoUrl, type: 'image/png' }
      : { href: DEFAULT_ICONS.icon, type: 'image/svg+xml' }

/** While a workspace with an icon is open, the tab shows that icon; null puts the install's back. */
export function setWorkspaceFavicon(url: string | null) {
  workspaceIcon = url
  const icon = tabIcon(current, workspaceIcon)
  setLink('icon', icon.href, icon.type)
}

function setLink(rel: string, href: string, type?: string) {
  for (const link of document.querySelectorAll<HTMLLinkElement>(`link[rel="${rel}"]`)) {
    link.href = href
    if (type) link.type = type
  }
}

function applyToPage(b: Branding) {
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', b.name)
  const icon = tabIcon(b, workspaceIcon)
  setLink('icon', icon.href, icon.type)
  setLink('apple-touch-icon', b.logoUrl ?? DEFAULT_ICONS.apple)
  // The primary color: --action, and the install's as --install-action for a partner's own screens (.k-install-brand).
  const root = document.documentElement.style
  for (const [prefix, color] of [
    ['--', b.color],
    ['--install-', install.color],
  ] as const) {
    if (color) {
      root.setProperty(`${prefix}action`, color)
      root.setProperty(`${prefix}on-action`, readableOn(color))
    } else {
      root.removeProperty(`${prefix}action`)
      root.removeProperty(`${prefix}on-action`)
    }
  }
}
