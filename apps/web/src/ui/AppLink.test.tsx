// The one link for a place in the app inside text (ui/AppLink.tsx): a plain hash link with the shared look, the same
// look for an action in text, a message tag rendered as the link, and Server admin places only for instance admins.
import { T } from '@linedesk/i18n/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, test } from 'vitest'
import { setProviderAudience } from '../providerAudience.ts'
import { MissingProviderNote } from '../settings/MissingProviderNote.tsx'
import { AppLink, adminLink, appLink, LinkButton } from './AppLink.tsx'

afterEach(() => setProviderAudience('member'))

test('a place in the app is a plain hash link with the shared look, so it opens like the menu does', () => {
  const html = renderToStaticMarkup(<AppLink to="#account/preferences">Account › Preferences</AppLink>)
  expect(html).toBe('<a class="k-link" href="#account/preferences">Account › Preferences</a>')
})

test('a new tab only when asked for (a walkthrough step stays where it is)', () => {
  const html = renderToStaticMarkup(
    <AppLink to="#account/security" newTab title="In a new tab">
      Security
    </AppLink>,
  )
  expect(html).toContain('target="_blank"')
  expect(html).toContain('rel="noopener"')
  expect(html).toContain('title="In a new tab"')
})

test('an action in text looks like the link but is a button', () => {
  const html = renderToStaticMarkup(<LinkButton onClick={() => {}}>Try again</LinkButton>)
  expect(html).toBe('<button type="button" class="k-link">Try again</button>')
})

test('a message tag renders the link around its own words, the sentence stays one message', () => {
  const html = renderToStaticMarkup(<T k="account.notify.oneplace" values={{ link: appLink('#assistant/emails') }} />)
  expect(html).toContain(
    'Call emails for the team are set in one place: <a class="k-link" href="#assistant/emails">Assistant › Who hears about calls</a>.',
  )
})

test('a Server admin place is a link for instance admins and plain words for everyone else', () => {
  const render = () =>
    renderToStaticMarkup(
      <T k="settings.assistant.realtimeVoice.body" values={{ link: adminLink('#admin/providers/answering') }} />,
    )
  expect(render()).toBe('The default voice is set by an instance admin under Server admin › Providers.')
  setProviderAudience('admin')
  expect(render()).toContain('<a class="k-link" href="#admin/providers/answering">Server admin › Providers</a>')
  expect(
    renderToStaticMarkup(<T k="settings.assistant.realtimeVoice.body" values={{ link: adminLink('#x', false) }} />),
  ).not.toContain('<a')
})

test('migrated: a missing provider names its place in Server admin as the shared link', () => {
  setProviderAudience('admin')
  const html = renderToStaticMarkup(<MissingProviderNote kind="calendar" />)
  expect(html).toContain('<a class="k-link" href="#admin/providers/calendar">Server admin › Providers</a>')
})
