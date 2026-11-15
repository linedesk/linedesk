// The one link for a place in the app inside text (docs/design-principles.md, rule 18): help lines, hints,
// notes, empty states and errors that name another page ("change that under Account › Preferences") make that name
// this link. Underlined, in the text's own ink, with the focus ring; a plain `<a href="#…">`, so it opens the place the
// same way the menu does (the hash routes, shell/useRoute.ts), and a middle click or ⌘-click opens a new tab.
// In a message, the place is a tag (`<link>Account › Preferences</link>`) that `appLink`/`adminLink` render.
import type { MouseEventHandler, ReactNode } from 'react'
import { providerAudience } from '../providerAudience.ts'

type AppLinkProps = {
  /** The place: a hash route (`#account/preferences`, `#admin/providers/answering`). */
  to: string
  /** Opens in a new tab: only where the page must stay as it is (a walkthrough step, design principle 14). */
  newTab?: boolean
  title?: string
  onClick?: MouseEventHandler<HTMLAnchorElement>
  children: ReactNode
}

export function AppLink({ to, newTab, title, onClick, children }: AppLinkProps) {
  return (
    <a
      className="k-link"
      href={to}
      title={title}
      onClick={onClick}
      {...(newTab ? { target: '_blank', rel: 'noopener' } : {})}
    >
      {children}
    </a>
  )
}

/** An action inside text ("Try again", "Confirm"): looks like the link, but does something here instead of going somewhere. */
export function LinkButton({ onClick, title, children }: { onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button type="button" className="k-link" title={title} onClick={onClick}>
      {children}
    </button>
  )
}

type TagRenderer = (chunks: ReactNode[]) => ReactNode

/** A message tag rendered as a link to `to`: `<T k="…" values={{ link: appLink('#account/preferences') }} />`. */
export const appLink =
  (to: string, options: Omit<AppLinkProps, 'to' | 'children'> = {}): TagRenderer =>
  chunks => (
    <AppLink to={to} {...options}>
      {chunks}
    </AppLink>
  )

/** The tag's words as they are, no link: for a place this viewer can't open. */
export const plainTag: TagRenderer = chunks => <>{chunks}</>

/**
 * A place in Server admin: a link for instance admins, plain words for everyone else (they can't open it).
 * `isAdmin` defaults to who reads problems with this install's providers in this tab (providerAudience.ts).
 */
export const adminLink = (to: string, isAdmin: boolean = providerAudience() === 'admin'): TagRenderer =>
  isAdmin ? appLink(to) : plainTag
