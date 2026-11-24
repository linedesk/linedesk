// The first transfer contact of a new assistant is named in the workspace's UI language, else its maker's, else English.
import { expect, test, vi } from 'vitest'

const resolved = vi.hoisted(() => ({ language: 'en' }))
vi.mock('./workspace-locale.ts', () => ({
  workspaceLocale: async () => ({ resolvedLanguage: resolved.language }),
}))
vi.mock('@linedesk/i18n/server', () => ({
  getT: (locale: string) => ({ t: (key: string) => `${locale}:${key}` }),
}))

const { newAssistantTransfers } = await import('./default-transfers.ts')
const nameIn = async (workspaceLanguage: string, creator?: string | null) => {
  resolved.language = workspaceLanguage
  const [contact, ...rest] = await newAssistantTransfers({} as never, 'ws_1', creator)
  expect(rest).toEqual([])
  return contact!.name
}

test("the contact is named in the workspace's UI language", async () => {
  expect(await nameIn('de', 'fr')).toBe('de:server.assistant.defaultTransferName')
  expect(await nameIn('pt', null)).toBe('pt-BR:server.assistant.defaultTransferName')
  expect(await nameIn('en', 'de')).toBe('en:server.assistant.defaultTransferName')
})

test("a workspace language the web app does not have: the maker's language, else English", async () => {
  expect(await nameIn('ko', 'ja')).toBe('ja:server.assistant.defaultTransferName')
  expect(await nameIn('ko', null)).toBe('en:server.assistant.defaultTransferName')
})

test('only the name changes: the condition stays English, for the assistant', async () => {
  resolved.language = 'de'
  const [contact] = await newAssistantTransfers({} as never, 'ws_1')
  expect(contact).toMatchObject({
    id: 'person',
    number: null,
    condition: 'The caller asks to speak to a person',
    enabled: true,
  })
})
