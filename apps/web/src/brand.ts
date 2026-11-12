// The install's branding (Admin, Branding; apps/api/src/branding.ts): product name, logo, primary color
// and whether the GitHub star prompt shows. Read before sign-in from GET /v1/branding and kept in
// localStorage, so the next page load shows the right name and logo at once. Applied to the page
// itself here (icons, primary color; Workspace.tsx sets the tab title); components read it with useBrand() or brandName().
import { type Branding, DEFAULT_BRANDING } from '@linedesk/actions'
import { useSyncExternalStore } from 'react'

const STORAGE_KEY = 'linedesk.branding'

function cached(): Branding | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULT_BRANDING, ...(JSON.parse(raw) as Partial<Branding>) } : null
  } catch {
    return null
  }
}

let current: Branding = cached() ?? DEFAULT_BRANDING
const listeners = new Set<() => void>()

/** The product name: "Linedesk" unless an instance admin renamed it. */
export const brandName = () => current.name

export const useBrand = (): Branding =>
  useSyncExternalStore(
    listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )

/** Makes `next` the branding in effect: stored for the next load, applied to the page, shown by every useBrand(). */
export function setBrand(next: Branding) {
  renameInTitle(current.name, next.name)
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private mode: the branding is fetched again on the next load.
  }
  applyToPage(next)
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

function setLink(rel: string, href: string, type?: string) {
  for (const link of document.querySelectorAll<HTMLLinkElement>(`link[rel="${rel}"]`)) {
    link.href = href
    if (type) link.type = type
  }
}

function applyToPage(b: Branding) {
  document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', b.name)
  setLink('icon', b.logoUrl ?? DEFAULT_ICONS.icon, b.logoUrl ? 'image/png' : 'image/svg+xml')
  setLink('apple-touch-icon', b.logoUrl ?? DEFAULT_ICONS.apple)
  const root = document.documentElement.style
  if (b.color) {
    root.setProperty('--action', b.color)
    root.setProperty('--on-action', readableOn(b.color))
  } else {
    root.removeProperty('--action')
    root.removeProperty('--on-action')
  }
}

/** Near-white text on a dark color, near-black on a light one (WCAG relative luminance). */
export function readableOn(hex: string): string {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2)
  return luminance > 0.179 ? '#1c1917' : '#fafaf8'
}
