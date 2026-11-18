// Settings › Recordings with recording off on the server: the saved choices stay as they are but greyed out, and one
// note says what turns recording on (a link to Server admin › Providers for an instance admin, "ask" for everyone else).
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { setProviderAudience } from '../providerAudience.ts'

const settings = vi.hoisted(() => ({
  data: {
    recordingOn: false,
    recordingRetentionDays: 0,
    recordingNoticeOn: true,
    recordingNotice: 'This call may be recorded.',
  } as Record<string, unknown>,
}))
vi.mock('./settings-api.ts', () => ({
  useWorkspaceSettings: () => ({ data: settings.data, error: null, reload: async () => {} }),
  patchWorkspaceSettings: vi.fn(),
}))
vi.mock('../store.tsx', () => ({ useRun: () => vi.fn() }))

const { Recordings, copyCallerPrivacyNotice } = await import('./Recordings.tsx')
const { callerPrivacyNotice } = await import('./callerPrivacyNotice.ts')
const { brandName } = await import('../brand.ts')

const render = (recordingOn: boolean, canEdit = true) => {
  settings.data = { ...settings.data, recordingOn }
  return renderToStaticMarkup(<Recordings canEdit={canEdit} toast={() => {}} />)
}
const disabledControls = (html: string) => (html.match(/disabled=""/g) ?? []).length

afterEach(() => setProviderAudience('member'))

test('recording off on the server: a note says so, the saved choices stay but cannot change', () => {
  const html = render(false)
  expect(html).toContain('Recording is off on this server.')
  expect(html).toContain('Ask your server admin to turn on recording.')
  expect(html).not.toContain('#admin/providers/recording')
  // Kept as saved: the switch is still on and the sentence still there, greyed out.
  expect(html).toContain('This call may be recorded.')
  expect(html).toContain('is-dimmed')
  // The retention select, the notice switch and the sentence.
  expect(disabledControls(html)).toBe(3)
})

test('an instance admin gets the link to the place that turns recording on', () => {
  setProviderAudience('admin')
  const html = render(false)
  expect(html).toContain('href="#admin/providers/recording"')
  expect(html).not.toContain('Ask your server admin')
})

test('recording on: no note, the controls work as before', () => {
  const html = render(true)
  expect(html).not.toContain('Recording is off on this server.')
  expect(html).not.toContain('is-dimmed')
  expect(disabledControls(html)).toBe(0)
  // A member still reads them only.
  expect(disabledControls(render(true, false))).toBe(3)
})

test('the caller privacy notice template follows the recording settings and can be copied by anyone', () => {
  settings.data = { ...settings.data, recordingRetentionDays: 30 }
  const on = render(true, false)
  expect(on).toContain('Caller privacy notice')
  // What it is for, at the top of the card.
  expect(on).toContain(
    'A text for your website or call notes that tells callers how their data is handled; in the EU the business must give this information.',
  )
  expect(on).toContain('Copy text')
  expect(on).toContain('delete the recordings after 30 days.')
  // Recording off on the server: the template says no audio is kept.
  expect(render(false)).toContain('We do not keep audio recordings of calls.')
  settings.data = { ...settings.data, recordingRetentionDays: 0 }
})

test('the caller privacy notice is folded away by default, opens to the whole text, and Copy takes all of it', async () => {
  settings.data = { ...settings.data, recordingRetentionDays: 30 }
  const html = render(true, false)
  settings.data = { ...settings.data, recordingRetentionDays: 0 }
  // Closed by default: a "Show text" disclosure, not open.
  const details = html.match(/<details class="st-privacy-more"( open="")?>([\s\S]*?)<\/details>/)
  expect(details).not.toBeNull()
  expect(details![1]).toBeUndefined()
  const [summary = '', body = ''] = details![2]!.split('</summary>')
  expect(summary).toContain('Show text')
  expect(summary).not.toContain('Hide text')
  // Opening it shows the hint and the whole text, as it will be pasted; nothing of it sits outside the disclosure.
  const full = callerPrivacyNotice({ on: true, days: 30 }, brandName())
  const escaped = full
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;')
  expect(body).toContain('fill in the parts in [brackets].')
  expect(body).toContain(`<pre class="st-privacy-text">${escaped}</pre>`)
  expect(body).not.toBe('')
  expect(html.replace(body, '')).not.toContain('delete the recordings after 30 days.')
  // The disclaimer: always visible, outside the folded part, and never part of the copied notice.
  const disclaimer = 'This is a template, not legal advice. Check it with your own adviser.'
  expect(html).toContain(`<p class="st-privacy-disclaimer">${disclaimer}</p>`)
  expect(html.indexOf(disclaimer)).toBeLessThan(html.indexOf('<details class="st-privacy-more"'))
  expect(body).not.toContain('not legal advice')
  expect(full).not.toContain('not legal advice')
  // Copy is in the header, outside the folded part, so it works while closed, and copies the full text.
  expect(html.indexOf('Copy text')).toBeLessThan(html.indexOf('<details class="st-privacy-more"'))
  const written: string[] = []
  expect(
    await copyCallerPrivacyNotice({ on: true, days: 30 }, { writeText: async text => void written.push(text) }),
  ).toBe('copied')
  expect(written).toEqual([full])
  expect(written[0]).toContain('How we handle your calls')
  expect(written[0]).toContain('delete the recordings after 30 days.')
  expect(written[0]).toContain('Questions or requests: [email or phone].')
  expect(
    await copyCallerPrivacyNotice({ on: true, days: 30 }, { writeText: () => Promise.reject(new Error('denied')) }),
  ).toBe('failed')
})

test('law hints by setting and country: only notes, every control stays usable (A4, A5)', () => {
  const eu = "In the EU and the UK, recording a call usually needs the caller's consent"
  const long = 'Privacy laws such as the GDPR'
  const noticeOff = 'Calls are recorded and transcribed without telling callers.'
  const at = (data: Record<string, unknown>) => {
    settings.data = { ...settings.data, recordingNoticeOn: true, ...data }
    return render(true).replaceAll('&#x27;', "'")
  }
  // The US, 90 days, notice on: nothing.
  let html = at({ resolvedCountry: 'US', recordingRetentionDays: 90 })
  for (const hint of [eu, long, noticeOff]) expect(html).not.toContain(hint)
  // Germany: the consent hint; kept forever: the retention hint too.
  expect(at({ resolvedCountry: 'DE', recordingRetentionDays: 90 })).toContain(eu)
  html = at({ resolvedCountry: 'DE', recordingRetentionDays: null })
  expect(html).toContain(eu)
  expect(html).toContain(long)
  expect(at({ resolvedCountry: 'US', recordingRetentionDays: 365 })).toContain(long)
  // Don't keep: nothing is recorded, so no hint.
  html = at({ resolvedCountry: 'DE', recordingRetentionDays: 0, recordingNoticeOn: false })
  for (const hint of [eu, long, noticeOff]) expect(html).not.toContain(hint)
  // The notice off while calls are recorded: a warning, worded by country.
  html = at({ resolvedCountry: 'US', recordingRetentionDays: 30, recordingNoticeOn: false })
  expect(html).toContain(`${noticeOff} In many US states, such as California, callers must be told first.`)
  html = at({ resolvedCountry: 'FR', recordingRetentionDays: 30, recordingNoticeOn: false })
  expect(html).toContain(`${noticeOff} In the EU and the UK, callers must be told`)
  expect(disabledControls(html)).toBe(0)
})
