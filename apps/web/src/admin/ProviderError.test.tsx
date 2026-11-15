import { readFileSync } from 'node:fs'
import { PROVIDER_ERROR_SUMMARY_MAX } from '@linedesk/actions'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import { ProviderError } from './ProviderError.tsx'

const RAW =
  'Conversation already has an active response in progress: resp_DfQ9xXkT2ab. Wait until the response is finished before creating a new one. {"type":"invalid_request_error","code":"conversation_already_has_active_response","message":"Conversation already has an active response in progress: re'

const lineOf = (html: string) => /<span class="adm-prov-error-line"[^>]*>([^<]*)<\/span>/.exec(html)?.[1] ?? ''

test('a raw provider error: one short human line, the full text and its time only under Details', () => {
  const html = renderToStaticMarkup(<ProviderError message={RAW} at="2026-11-15T01:00:00.000Z" />)
  expect(lineOf(html)).toBe('A call sent two replies at once. Calls still work.')
  expect(html).toContain('<details class="adm-prov-error-details"><summary')
  expect(html).toContain('dateTime="2026-11-15T01:00:00.000Z"')
  // The raw JSON is in the details only, never in the visible line.
  expect(html.split('<details')[0]).not.toContain('{')
})

test('a long unbroken text is one line of at most the summary length; the full text wraps anywhere', () => {
  const unbroken = 'x'.repeat(2000)
  const html = renderToStaticMarkup(<ProviderError message={unbroken} />)
  expect(lineOf(html).length).toBeLessThanOrEqual(PROVIDER_ERROR_SUMMARY_MAX)
  expect(html).toContain('class="adm-prov-error-full"')
})

test('a short error that says everything has no Details', () => {
  expect(renderToStaticMarkup(<ProviderError message="Socket closed" />)).not.toContain('<details')
})

// The layout rules that keep an error from widening its card or column (jsdom has no layout, so the stylesheet is checked).
test('the stylesheet cuts the line with an ellipsis, wraps the details anywhere and lets the columns shrink', () => {
  const css = readFileSync(new URL('./admin.css', import.meta.url), 'utf8')
  const rule = (selector: string) => new RegExp(`${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
  expect(rule('.adm-prov-error-line')).toMatch(/white-space: nowrap;[\s\S]*text-overflow: ellipsis;/)
  expect(rule('.adm-prov-error-full')).toContain('overflow-wrap: anywhere;')
  expect(rule('.adm-prov-error')).toContain('min-width: 0;')
  expect(rule('.adm-provcat')).toContain('min-width: 0;')
  expect(rule('.adm-prov-name')).toContain('min-width: 0;')
})
