// The API's modules load in the order server.ts loads them. Import cycles (forwarding-check.ts and outbound-policy.ts
// import each other) make that order matter: a module reading an imported binding at its top level crashes the start
// with "Cannot access … before initialization" when the other side of the cycle loads first (the CHECK_TRUNK_NAME crash
// after #804). The other tests import modules in their own order and never see it. This loads server.ts's own modules
// (the static and the dynamic imports, in the file's order) in a fresh Node process, without starting the server.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { expect, test } from 'vitest'

const apiDir = new URL('..', import.meta.url)
const serverSource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')

/** server.ts's own modules (`from './x.ts'` and `import('./x.ts')`), in the order they appear. */
const serverModules = [...serverSource.matchAll(/(?:from\s+|import\(\s*)'(\.\/[\w./-]+\.ts)'/g)].map(m => m[1]!)

test('server.ts imports its own modules', () => {
  expect(serverModules).toContain('./app.ts')
  expect(serverModules).toContain('./admin-passkey-codes.ts')
})

test("the API's modules load in server.ts order (no import cycle reads a binding before it is set)", async () => {
  const script = [
    `for (const m of ${JSON.stringify(serverModules.map(m => `./src/${m.slice(2)}`))}) await import(m)`,
    `console.log('loaded')`,
    `process.exit(0)`,
  ].join('\n')
  // A database no module may reach while loading: loading must not need one.
  const env = { ...process.env, DATABASE_URL: 'postgres://boot:boot@127.0.0.1:1/boot' }
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    {
      cwd: apiDir,
      env,
      timeout: 60_000,
    },
  )
  expect(stdout).toContain('loaded')
}, 90_000)
