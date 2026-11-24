import { type AgentClient, agentClients } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { SetUpYourself, StartAgent } from './AgentSetup.tsx'

const URL = 'https://desk.example.com/mcp/setup/lds_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const render = (client: AgentClient) => renderToStaticMarkup(<StartAgent client={client} url={URL} />)
/** Where the first match sits in the markup: earlier means higher on the page. */
const at = (html: string, pattern: RegExp) => html.search(pattern)

describe('StartAgent: the open link first where there is one', () => {
  const opens: [AgentClient, string, string][] = [
    ['claude_code', 'Open in Claude Code', 'Or copy the command for a terminal'],
    ['copilot', 'Open in VS Code', 'Or add the setup server first'],
    ['cursor', 'Open in Cursor', 'Or copy the prompt'],
  ]

  test.each(opens)(
    '%s: the open button is the primary action, the other way follows behind a closed "Or …"',
    (client, label, otherWay) => {
      const html = render(client)
      const button = at(html, new RegExp(`<a class="k-btn k-btn-primary k-btn-md" href="[a-z]+://[^"]+">${label}</a>`))
      expect(button).toBeGreaterThanOrEqual(0)
      // One line on what happens, right after the button.
      expect(html).toMatch(new RegExp(`${label}</a><span class="as-small">Opens [^<]+</span>`))
      // The other way: below the button, in a disclosure that starts closed, with nothing primary in it.
      expect(html).toContain(`<details class="as-other-way"><summary>${otherWay}</summary>`)
      expect(html).not.toMatch(/<details[^>]* open/)
      expect(at(html, /<details/)).toBeGreaterThan(button)
      expect(html.match(/k-btn-primary/g)).toHaveLength(1)
      expect(html.slice(at(html, /<details/))).toMatch(/<button[^>]*k-btn-secondary[^>]*>.*Copy/)
    },
  )

  test('Claude Code: the terminal command is still there to copy, behind "Or copy the command for a terminal"', () => {
    const html = render('claude_code')
    const other = html.slice(at(html, /<details/))
    expect(other).toContain('Run this in a terminal')
    expect(other).toMatch(/<code>claude &#x27;/)
    expect(at(html, /Run this in a terminal/)).toBeGreaterThan(at(html, /Open in Claude Code/))
  })

  test('Cursor: the prompt to copy is the other way, its text folded behind Show prompt', () => {
    const other = render('cursor').split('<details')[1]!
    expect(other).toContain('Copy prompt')
    expect(other).toMatch(/aria-expanded="false"[^>]*>.*Show prompt/)
    expect(other).not.toContain('<pre class="as-prompt">')
  })

  test('agents without an open link keep their steps as the way, no "Or …" disclosure (only a fallback folded away)', () => {
    const without = agentClients.filter(client => !opens.some(([id]) => id === client))
    expect(without).toEqual(['claude', 'chatgpt', 'codex', 'gemini', 'other'])
    for (const client of without) {
      const html = render(client)
      expect(html.replaceAll('<details class="as-other-way as-fallback">', ''), client).not.toContain('<details')
      expect(html, client).not.toContain('as-open')
      // At most one primary: the first step's copy or link (Claude and ChatGPT start with a step to do in their app).
      expect((html.match(/k-btn-primary/g) ?? []).length, client).toBeLessThanOrEqual(1)
    }
    // Codex: the one command to copy leads.
    expect(render('codex')).toMatch(/Run this in a terminal[\s\S]*<code>codex [\s\S]*k-btn-primary[^>]*>.*Copy/)
    // Other: the prompt to copy leads.
    expect(render('other')).toMatch(/<pre class="as-prompt">[\s\S]*k-btn-primary[^>]*>.*Copy prompt/)
    // Claude on the web: the connector first, its Open Claude link last (it needs the connector).
    const claude = render('claude')
    expect(at(claude, /Add custom connector/)).toBeLessThan(at(claude, />Open Claude</))
  })
})

describe("StartAgent for a workspace owner's link", () => {
  test('the same way to start, with the business prompt: nothing about the server', () => {
    for (const client of agentClients) {
      const html = renderToStaticMarkup(<StartAgent client={client} url={URL} scope="workspace" />)
      expect(html, client).not.toMatch(/on my server|provider_setKeys/)
    }
    expect(renderToStaticMarkup(<StartAgent client="other" url={URL} scope="workspace" />)).toMatch(
      /set up my business in Linedesk/,
    )
  })
})

describe("StartAgent: direct links to the cloud apps' own settings", () => {
  test('Claude: says it cannot add the server itself and opens Add custom connector filled in, in a new tab, first', () => {
    const claude = render('claude')
    expect(claude).toContain('Claude cannot add the setup server by itself')
    const settings = at(
      claude,
      new RegExp(
        `<a class="k-btn k-btn-primary k-btn-sm" href="https://claude\\.ai/customize/connectors\\?modal=add-custom-connector&amp;connectorName=Linedesk%20setup&amp;connectorUrl=${encodeURIComponent(URL)}" target="_blank" rel="noopener noreferrer">Open in Claude</a>`,
      ),
    )
    expect(settings).toBeGreaterThanOrEqual(0)
    // The address to copy stays, below the link, in case the link did not fill it in.
    // Folded away: only for when the link did not fill it in.
    expect(settings).toBeLessThan(
      at(claude, /<details class="as-other-way as-fallback"><summary>Link didn&#x27;t fill in the URL\? Copy it here</),
    )
    expect(claude).toContain(`<code>${URL}</code>`)
    // Numbered: 1 the connector, 2 the chat.
    expect(claude).toMatch(/<ol class="as-steps">[\s\S]*>1<[\s\S]*>2<\/span>[\s\S]*Open Claude/)
    // The chat link opens claude.ai in a new tab too.
    expect(claude).toMatch(
      /href="https:\/\/claude\.ai\/new\?q=[^"]+" target="_blank" rel="noopener noreferrer">Open Claude</,
    )
  })

  test('ChatGPT: its plugins page, in a new tab', () => {
    const chatgpt = render('chatgpt')
    expect(chatgpt).toContain('ChatGPT cannot add the setup server by itself')
    expect(chatgpt).toMatch(
      /href="https:\/\/chatgpt\.com\/plugins" target="_blank" rel="noopener noreferrer">Open ChatGPT plugins</,
    )
    // Three numbered steps; the form drawn filled in, the name and the URL each with a Copy button.
    expect(chatgpt).toMatch(/<ol class="as-steps">/)
    expect(chatgpt.match(/class="as-step-number"/g)).toHaveLength(3)
    expect(chatgpt).toMatch(
      /class="as-form-label">Name<\/span><div class="as-code as-code-line"><code title="Linedesk setup">Linedesk setup<\/code><button[^>]*><span>Copy</,
    )
    // The URL on one line, cut short on screen: the tooltip and Copy have all of it.
    expect(chatgpt).toContain(`<code title="${URL}">${URL}</code>`)
    expect(chatgpt).toMatch(/as-form-pick[\s\S]*No authentication/)
    expect(chatgpt).toContain('Create as a plugin')
    // The plugins link beside its step's text; the prompt folded: Copy prompt and Show prompt, no text until asked.
    expect(chatgpt).toMatch(
      /<div class="as-step-inline"><span>ChatGPT cannot add[^<]*<\/span><a[^>]*chatgpt\.com\/plugins/,
    )
    expect(chatgpt).toContain('Copy prompt')
    expect(chatgpt).toContain('Show prompt')
    expect(chatgpt).not.toContain('<pre class="as-prompt">')
  })

  test('links that open an app on this computer stay in this tab', () => {
    for (const client of ['claude_code', 'cursor', 'copilot'] as const)
      expect(render(client)).not.toMatch(/href="(claude|cursor|vscode):[^"]*" target=/)
  })
})

describe('SetUpYourself: the way without an AI agent', () => {
  test('a real secondary button with its line, which opens the setup by hand', () => {
    const onClick = vi.fn()
    const props = {
      text: 'No AI agent? Set it up yourself, one step at a time.',
      label: 'Set it up yourself',
      title: 'Go through the setup steps yourself',
      onClick,
    }
    const html = renderToStaticMarkup(<SetUpYourself {...props} />)
    expect(html).toMatch(
      /class="as-by-hand"><span>No AI agent\? Set it up yourself, one step at a time\.<\/span><button[^>]*k-btn-secondary/,
    )
    expect(html).toContain('Set it up yourself</')
    // The button's click is the page's way by hand (AgentSetup passes its `manual`).
    const button = (SetUpYourself(props) as { props: { children: { props: { onClick: () => void } }[] } }).props
      .children[1]!
    button.props.onClick()
    expect(onClick).toHaveBeenCalledOnce()
  })
})
