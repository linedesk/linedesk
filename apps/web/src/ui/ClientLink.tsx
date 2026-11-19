// A button that opens an AI client: its one-click install link (Cursor, VS Code), a link that opens the app with a
// prompt (Claude Code, Cursor, Copilot), or the client's own settings page where the person adds a server (Claude,
// ChatGPT; packages/actions/src/agent-client-links.ts). One look for all of them, on the agent setup page
// (onboarding/AgentSetup.tsx, StartAgent) and in Integrations › MCP. A web page opens in a new tab; an app link
// (cursor://, vscode:, claude://) opens the app and leaves this page where it is.
import { opensWebPage } from '@linedesk/actions'
import { cx } from './kit.tsx'

export type ClientLinkProps = {
  href: string
  label: string
  /** The tooltip: where the link goes. */
  title?: string
  variant?: 'primary' | 'secondary'
  size?: 'sm' | 'md'
}

export function ClientLink({ href, label, title, variant = 'secondary', size = 'sm' }: ClientLinkProps) {
  const web = opensWebPage(href)
  return (
    <a
      className={cx('k-btn', `k-btn-${variant}`, `k-btn-${size}`)}
      href={href}
      title={title}
      {...(web ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      {label}
    </a>
  )
}

/** A row of client links, side by side (wrapping on a phone). */
export function ClientLinks({ links }: { links: readonly ClientLinkProps[] }) {
  return (
    <div className="client-links">
      {links.map(link => (
        <ClientLink key={link.href} {...link} />
      ))}
    </div>
  )
}
