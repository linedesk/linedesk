// UI parity (LIN-339): everything the web app does, a person can do with a personal key over the API, MCP and the
// CLI, with exactly their rights. Fails when an action or a route the web app calls has no key path and is not listed
// with its reason (personal-key-scope.ts, key-reads.ts). No database: it checks the registry and the sources.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { actions, type Permission, rolePermissions } from '@linedesk/actions'
import { describe, expect, test } from 'vitest'
import type { Actor } from '../src/context.ts'
import { BROWSER_ONLY_ROUTES, KEY_READ_ROUTES, keyReadRoute, personalKeyMayRequest } from '../src/key-reads.ts'
import { NOT_OVER_MCP, NOT_OVER_MCP_FOR_PERSONAL_KEYS, offeredOverMcp } from '../src/mcp.ts'
import { PERSONAL_KEY_REFUSED } from '../src/personal-key-scope.ts'
import { runnableBy } from '../src/run-action.ts'

/** Permissions no person holds: the voice agent's and Stripe's. */
const NOT_A_PERSON: ReadonlySet<Permission> = new Set(['agent', 'billing:system'])

/** A personal key of a workspace owner who is an instance admin and made the key after the passkey check. */
const fullKey: Actor = {
  actorId: 'u_owner',
  role: 'owner',
  workspaceId: 'ws_1',
  permissions: [...rolePermissions.owner, 'instance:admin', 'setupLink:end'],
  personalKeyId: 'pkey_1',
  passkeyConfirmed: true,
}

describe('every action a person runs in the app has a personal-key path', () => {
  const personActions = [...actions.values()].filter(def => !NOT_A_PERSON.has(def.permission))

  test.each(personActions.map(def => [def.name, def] as const))('%s', (name, def) => {
    if (PERSONAL_KEY_REFUSED.has(name)) {
      expect(runnableBy(def, fullKey)).toBe(false)
      return
    }
    expect(
      runnableBy(def, fullKey),
      `${name}: a personal key cannot run it; allow it or list it in personal-key-scope.ts`,
    ).toBe(true)
    if (!NOT_OVER_MCP.has(name) && !NOT_OVER_MCP_FOR_PERSONAL_KEYS.has(name))
      expect(offeredOverMcp(def, fullKey), `${name}: not offered over MCP`).toBe(true)
  })

  test('every refusal names an action and gives a reason', () => {
    for (const [name, reason] of PERSONAL_KEY_REFUSED) {
      expect(actions.has(name), name).toBe(true)
      expect(reason.length).toBeGreaterThan(10)
    }
  })

  test('a member key gets what a member gets, no more', () => {
    const member: Actor = {
      ...fullKey,
      role: 'member',
      permissions: [...rolePermissions.member],
      passkeyConfirmed: undefined,
    }
    for (const def of actions.values()) {
      if (!rolePermissions.member.includes(def.permission)) expect(runnableBy(def, member), def.name).toBe(false)
    }
    expect(runnableBy(actions.get('call.markDone')!, member)).toBe(true)
    expect(runnableBy(actions.get('team.invite')!, member)).toBe(false)
  })

  test('a workspace API key still gets only public actions', () => {
    const apiKey: Actor = {
      ...fullKey,
      personalKeyId: undefined,
      apiKeyId: 'key_1',
      role: 'admin',
      permissions: [...rolePermissions.admin],
    }
    for (const def of actions.values()) if (!def.public) expect(runnableBy(def, apiKey), def.name).toBe(false)
  })

  test('keys never manage keys: account:own is in no role', () => {
    for (const role of Object.values(rolePermissions)) expect(role).not.toContain('account:own')
    for (const name of ['personalKey.create', 'personalKey.list', 'personalKey.revoke'])
      expect(runnableBy(actions.get(name)!, { ...fullKey, permissions: [...fullKey.permissions, 'account:own'] })).toBe(
        false,
      )
  })
})

/** The /v1 paths the web app's sources call, as route patterns (`${…}` → `:x`, no query). */
function webRoutes(): string[] {
  const root = new URL('../../web/src', import.meta.url).pathname
  const files: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path)
    }
  }
  walk(root)
  const found = new Set<string>()
  for (const file of files)
    for (const [, raw] of readFileSync(file, 'utf8').matchAll(/[`'"](\/v1\/[^`'"\s]*)/g)) {
      const route = raw!
        .replace(/\$\{[^}]*\}/g, ':x')
        .split('?')[0]!
        .replace(/:x(:x)+/g, ':x')
      if (route !== '/v1/' && !route.startsWith('/v1/…')) found.add(route)
    }
  return [...found].sort()
}

const matches = (pattern: string, route: string) =>
  new RegExp(`^${pattern.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(route.replace(/:x/g, 'x'))

describe("every route the web app calls is readable with a key or listed as the browser's", () => {
  test.each(webRoutes())('%s', route => {
    const viaAction = route.startsWith('/v1/actions/')
    const viaRead = keyReadRoute(route.replace(/:x/g, 'x')) !== null
    const browserOnly = [...BROWSER_ONLY_ROUTES.keys()].some(pattern => matches(pattern, route))
    expect(
      viaAction || viaRead || browserOnly,
      `${route}: add it to KEY_READ_ROUTES or BROWSER_ONLY_ROUTES (key-reads.ts)`,
    ).toBe(true)
  })

  test('a personal key reaches actions and listed reads only', () => {
    expect(personalKeyMayRequest('POST', '/v1/actions/call.markDone')).toBe(true)
    expect(personalKeyMayRequest('GET', '/v1/admin/overview')).toBe(true)
    expect(personalKeyMayRequest('GET', '/v1/calls/c_1/recording')).toBe(true)
    expect(personalKeyMayRequest('GET', '/v1/shape/calls')).toBe(false)
    expect(personalKeyMayRequest('POST', '/v1/impersonation/start')).toBe(false)
    expect(personalKeyMayRequest('POST', '/v1/workspaces')).toBe(false)
    expect(personalKeyMayRequest('GET', '/v1/admin/../shape/calls')).toBe(false)
    expect(personalKeyMayRequest('GET', '/v1/me/x')).toBe(false)
  })

  test("no route is both readable and the browser's", () => {
    for (const { path } of KEY_READ_ROUTES) expect(BROWSER_ONLY_ROUTES.has(path), path).toBe(false)
  })
})
