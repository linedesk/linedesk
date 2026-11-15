import { type AgentClient, agentClients } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { StartAgent } from './AgentSetup.tsx'

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

  test('Cursor: the prompt to copy is the other way', () => {
    const other = render('cursor').split('<details')[1]!
    expect(other).toContain('<pre class="as-prompt">')
    expect(other).toContain('Copy prompt')
  })

  test('agents without an open link keep their steps as the way, unchanged, no disclosure', () => {
    const without = agentClients.filter(client => !opens.some(([id]) => id === client))
    expect(without).toEqual(['claude', 'chatgpt', 'codex', 'gemini', 'other'])
    for (const client of without) {
      const html = render(client)
      expect(html, client).not.toContain('<details')
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
