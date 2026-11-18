// The settings layout (after shadcn's): one head for every settings area (Assistant, Workspace, Account, Server admin,
// Partner area). The page bar holds the menu or back button and the area's title; under it, a context line (the
// assistant switcher, the workspace's name, the account's email) at the same size and place on every page; then a
// narrow nav of the page's sections at the left and one section at a time at the right, its title inside its card.
// Each section has its own hash (`#assistant/<id>/transfers`), so links, reload and Back work. Below 720 px the nav is
// a row of tabs that scrolls sideways, faded at an edge with more tabs behind it.
import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import './settings-layout.css'
import { useT } from '@linedesk/i18n/react'

export type PageSection<T extends string = string> = {
  id: T
  label: string
  description?: string
  /** Open items in it, shown as a small count next to the label (none at 0). */
  count?: number
  /** The key that opens it (Server admin: 1 to 9), named in the tooltip. */
  shortcut?: string
  /** Something to flag next to the label (Server admin › Overview: a part of the install needs attention). */
  mark?: ReactNode
}

/** The page's part of the hash: `#<page>/<section>`; `page` may have a part of its own (`assistant/<id>`). */
export const sectionHash = (page: string, section: string) => `#${page}/${section}`

/**
 * The section the hash names on `page`, and the thing open in it (`#settings/phone/<number id>`), each '' when
 * the hash names none.
 */
export function sectionParts(page: string, hash: string): { section: string; item: string } {
  const path = hash.replace(/^#/, '').split('?')[0]!
  if (!path.startsWith(`${page}/`)) return { section: '', item: '' }
  const [section = '', item = ''] = path.slice(page.length + 1).split('/')
  return { section, item }
}

function sectionOf<T extends string>(page: string, sections: readonly PageSection<T>[], hash: string): T {
  const { section } = sectionParts(page, hash)
  return sections.find(s => s.id === section)?.id || sections[0]!.id
}

/**
 * A click in the nav shows its section in the same frame: the browser's `hashchange` comes a few
 * milliseconds after the click, and until then the previous section would stay on screen.
 */
const sectionClicks = new Set<(hash: string) => void>()

/**
 * The hash with an unknown section (`#settings/nope`) replaced by the section shown instead, the page's first, so
 * the address says what is on screen; null when the hash names a section of the page, or none.
 */
export function knownSectionHash(page: string, sections: readonly PageSection[], hash: string): string | null {
  const query = hash.split('?')[1]
  const { section } = sectionParts(page, hash)
  if (!section || sections.some(s => s.id === section)) return null
  return `${sectionHash(page, sections[0]!.id)}${query ? `?${query}` : ''}`
}

/** The section the hash names; the first one when it names none (or one that does not exist, then the hash says so too). */
export function useSection<T extends string>(page: string, sections: readonly PageSection<T>[]): T {
  const [current, setCurrent] = useState(() => sectionOf(page, sections, window.location.hash))
  useEffect(() => {
    const show = (hash: string) => {
      const known = knownSectionHash(page, sections, hash)
      if (known && hash === window.location.hash) window.history.replaceState(null, '', known)
      setCurrent(sectionOf(page, sections, hash))
    }
    const onHash = () => show(window.location.hash)
    window.addEventListener('hashchange', onHash)
    sectionClicks.add(show)
    show(window.location.hash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      sectionClicks.delete(show)
    }
  }, [page, sections])
  return current
}

/** A plain click on a section link (not one that opens a new tab): shown now, the hash follows. */
function showSectionNow(event: MouseEvent, hash: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  for (const show of sectionClicks) show(hash)
}

type Props<T extends string> = {
  page: string
  title: string
  /**
   * The context line above the nav: what this page is about (the workspace's name, the account's email, the assistant
   * switcher). One size and place on every settings page.
   */
  context?: ReactNode
  /** At the right of the context line, in every section (e.g. Start test call). */
  actions?: ReactNode
  sections: readonly PageSection<T>[]
  current: T
  /** Sections with unsaved changes: a dot in the nav. */
  unsaved?: ReadonlySet<T>
  /** Under the context line, above nav and content (e.g. a running test call). */
  banner?: ReactNode
  children: ReactNode
}

/** Which edges of the phone's tab row have more tabs behind them: those fade out. */
type Fade = 'start' | 'end' | 'both' | undefined

export function fadeOf(nav: Pick<HTMLElement, 'scrollWidth' | 'clientWidth' | 'scrollLeft'>): Fade {
  const more = nav.scrollWidth - nav.clientWidth
  if (more <= 1) return undefined
  const start = nav.scrollLeft > 1
  const end = nav.scrollLeft < more - 1
  return start && end ? 'both' : start ? 'start' : end ? 'end' : undefined
}

export function SettingsLayout<T extends string>(props: Props<T>) {
  const t = useT()
  const { page, title, context, actions, sections, current, unsaved, banner, children } = props
  const nav = useRef<HTMLElement>(null)
  const [fade, setFade] = useState<Fade>(undefined)
  // On a phone the nav is a row that scrolls sideways: the open section is scrolled to the middle (the tabs before it
  // stay in sight), and an edge with more tabs behind it fades out, so the row reads as one that scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs again whenever another section opens
  useEffect(() => {
    const row = nav.current
    const item = row?.querySelector<HTMLElement>('[aria-current="page"]')
    if (row && item && row.scrollWidth > row.clientWidth) {
      const box = row.getBoundingClientRect()
      const at = item.getBoundingClientRect()
      row.scrollLeft += at.left - box.left - (box.width - at.width) / 2
    }
    if (row) setFade(fadeOf(row))
  }, [current])
  useEffect(() => {
    const row = nav.current
    if (!row) return
    const update = () => setFade(fadeOf(row))
    row.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    return () => {
      row.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])
  return (
    <div className="page-in sl-page">
      <div className="page-head sl-head">
        <h1>{title}</h1>
        {(context || actions) && (
          <div className="sl-context">
            <div className="sl-context-main">{context}</div>
            {actions && <div className="sl-actions">{actions}</div>}
          </div>
        )}
      </div>
      {banner}
      <div className="sl-body">
        <nav ref={nav} className="sl-nav" data-fade={fade} aria-label={t('common.settingsLayout.sections', { title })}>
          {sections.map(s => {
            const dirty = unsaved?.has(s.id)
            return (
              <a
                key={s.id}
                href={sectionHash(page, s.id)}
                className="nav-item sl-item"
                onClick={e => showSectionNow(e, sectionHash(page, s.id))}
                aria-current={s.id === current ? 'page' : undefined}
                // A tooltip only when it says more than the label (its key): one repeating the label would cover the
                // line above the nav on hover (the partner area, 2026-11-18).
                title={s.shortcut ? `${s.label} (${s.shortcut})` : undefined}
                data-desc={s.description}
              >
                <span>{s.label}</span>
                {!!s.count && <span className="nav-n">{s.count}</span>}
                {s.mark}
                {dirty && <span className="sl-dot" role="img" aria-label={t('common.unsaved')} />}
              </a>
            )
          })}
        </nav>
        <div className="sl-content">{children}</div>
      </div>
    </div>
  )
}
