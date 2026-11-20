import { writeFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { ChatGptSteps } from './Integrations.tsx'

describe('Settings › Integrations › MCP: ChatGPT', () => {
  vi.stubGlobal('window', { location: { origin: 'https://desk.example' } })

  test("three numbered steps; ChatGPT's form drawn filled in: the name and the server address to copy, OAuth picked", () => {
    const html = renderToStaticMarkup(<ChatGptSteps brand="Linedesk" />)
    if (process.env.SHOT_HTML) writeFileSync(process.env.SHOT_HTML, html)
    expect(html).toMatch(/<ol class="as-steps ig-chatgpt-steps">/)
    expect(html.match(/class="as-step-number"/g)).toHaveLength(3)
    expect(html).toMatch(/href="https:\/\/chatgpt\.com\/plugins"[^>]*>Open ChatGPT plugins</)
    expect(html).toMatch(/class="as-form-label">Name<\/span><div class="as-code"><code>Linedesk<\/code><button[^>]*><span>Copy</)
    expect(html).toMatch(/class="as-form-label">Server URL<\/span><div class="as-code"><code>https:\/\/desk\.example\/mcp<\/code>/)
    expect(html).toMatch(/as-form-pick[\s\S]*OAuth/)
    expect(html).toContain('Create as a plugin')
    expect(html).toContain('Click Install on the new plugin')
  })
})
