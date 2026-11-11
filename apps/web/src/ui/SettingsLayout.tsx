// The settings layout (after shadcn's): the page title, a narrow nav of the page's sections at the
// left, one section at a time at the right. Each section has its own hash (`#assistant/greeting`),
// so links, reload and Back work. Below 720 px the nav is a row of tabs that scrolls sideways.
import { type ReactNode, useEffect, useRef, useState } from 'react'
import './settings-layout.css'

export type PageSection<T extends string = string> = { id: T; label: string; description?: string }

/** The page's part of the hash: `#<page>/<section>`; `page` may have a part of its own (`assistant/<id>`). */
export const sectionHash = (page: string, section: string) => `#${page}/${section}`

function sectionOf<T extends string>(page: string, sections: readonly PageSection<T>[], hash: string): T {
  const path = hash.replace(/^#/, '').split('?')[0]!
  const section = path.startsWith(`${page}/`) ? path.slice(page.length + 1) : ''
  return sections.find(s => s.id === section)?.id || sections[0]!.id
}

/** The section the hash names; the first one when it names none (or one that does not exist). */
export function useSection<T extends string>(page: string, sections: readonly PageSection<T>[]): T {
  const [current, setCurrent] = useState(() => sectionOf(page, sections, window.location.hash))
  useEffect(() => {
    const onHash = () => setCurrent(sectionOf(page, sections, window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [page, sections])
  return current
}

type Props<T extends string> = {
  page: string
  title: string
  description?: ReactNode
  /** In place of the description: something the page heads itself with (the assistant's name and switcher). */
  heading?: ReactNode
  /** At the right of the title, in every section (e.g. Start test call). */
  actions?: ReactNode
  sections: readonly PageSection<T>[]
  current: T
  /** Sections with unsaved changes: a dot in the nav. */
  unsaved?: ReadonlySet<T>
  /** Under the title, above nav and content (e.g. a running test call). */
  banner?: ReactNode
  children: ReactNode
}

export function SettingsLayout<T extends string>(props: Props<T>) {
  const { page, title, description, heading, actions, sections, current, unsaved, banner, children } = props
  const nav = useRef<HTMLElement>(null)
  // On a phone the nav is a row that scrolls sideways: keep the open section in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs again whenever another section opens
  useEffect(() => {
    const item = nav.current?.querySelector<HTMLElement>('[aria-current="page"]')
    if (item && nav.current && nav.current.scrollWidth > nav.current.clientWidth)
      nav.current.scrollLeft = item.offsetLeft - nav.current.offsetLeft - 12
  }, [current])
  return (
    <div className="page-in sl-page">
      <div className="page-head sl-head">
        <div>
          <h1>{title}</h1>
          {heading}
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="sl-actions">{actions}</div>}
      </div>
      {banner}
      <div className="sl-body">
        <nav ref={nav} className="sl-nav" aria-label={`${title} sections`}>
          {sections.map(s => {
            const dirty = unsaved?.has(s.id)
            return (
              <a
                key={s.id}
                href={sectionHash(page, s.id)}
                className="nav-item sl-item"
                aria-current={s.id === current ? 'page' : undefined}
                title={s.label}
                data-desc={s.description}
              >
                <span>{s.label}</span>
                {dirty && <span className="sl-dot" role="img" aria-label="Unsaved changes" />}
              </a>
            )
          })}
        </nav>
        <div className="sl-content">{children}</div>
      </div>
    </div>
  )
}
