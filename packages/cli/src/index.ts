// `linedesk`: everything the web app does, from a terminal, with a personal API key (docs/api.md, LIN-339). Actions
// run through POST /v1/actions/<name>, the app's one write path; reads through the GET routes a key may use.
import { createInterface } from 'node:readline/promises'
import { actionInput, parseArgs, type Parsed } from './args.ts'
import { type Config, normalizeUrl, readConfig, removeConfig, writeConfig } from './config.ts'

type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  description?: string
  enum?: unknown[]
}
type ActionInfo = {
  name: string
  description: string
  permission: string
  readOnly: boolean
  destructive: boolean
  input: JsonSchema
}

const USAGE = `linedesk: run Linedesk from the terminal with a personal API key (Account settings, Personal API keys).

  linedesk login --url https://app.example.com   store the server and a key (asked for, not shown)
  linedesk logout                                 forget them
  linedesk whoami                                 who the key acts as, and in which workspace
  linedesk workspaces                             your workspaces (use one with --workspace <id>)
  linedesk actions [text]                         the actions you may run, filtered by text
  linedesk help <action>                          an action's fields
  linedesk <action> [--field value …] [--json '{…}']  run an action (call.markDone --callId c_1)
  linedesk get <path>                             read a route (/v1/admin/overview); --raw writes bytes as they come

Options: --workspace <id> for another of your workspaces; --yes to run a destructive action without asking.
Environment: LINEDESK_URL and LINEDESK_API_KEY instead of login.`

/** A refusal the user can act on: printed as it is, exit code 1. */
class Failure extends Error {}

type Io = { out: (text: string) => void; err: (text: string) => void }
const stdio: Io = { out: text => process.stdout.write(`${text}\n`), err: text => process.stderr.write(`${text}\n`) }

async function connection(parsed: Parsed): Promise<Config> {
  const config = await readConfig()
  if (!config.url || !config.key)
    throw new Failure('not signed in: run `linedesk login --url <server>` or set LINEDESK_URL and LINEDESK_API_KEY')
  const workspace = parsed.options.get('workspace')
  return {
    url: config.url,
    key: config.key,
    ...(typeof workspace === 'string' ? { workspace } : config.workspace ? { workspace: config.workspace } : {}),
  }
}

async function request(config: Config, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
  const headers: Record<string, string> = { authorization: `Bearer ${config.key}`, accept: 'application/json' }
  if (config.workspace) headers['x-workspace-id'] = config.workspace
  if (body !== undefined) headers['content-type'] = 'application/json'
  try {
    return await fetch(`${config.url}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (e) {
    throw new Failure(`cannot reach ${config.url}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function json(res: Response): Promise<unknown> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  if (!res.ok) throw new Failure(typeof body?.error === 'string' ? body.error : `the server answered ${res.status}`)
  return body
}

const show = (io: Io, value: unknown) => io.out(JSON.stringify(value, null, 2))

async function listActions(config: Config): Promise<ActionInfo[]> {
  const body = (await json(await request(config, 'GET', '/v1/me/actions'))) as { actions: ActionInfo[] }
  return body.actions
}

async function findAction(config: Config, name: string): Promise<ActionInfo> {
  const found = (await listActions(config)).find(a => a.name === name)
  if (!found) throw new Failure(`no action ${name} you may run here: see \`linedesk actions\``)
  return found
}

function describeFields(schema: JsonSchema, prefix = ''): string[] {
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties ?? {}).flatMap(([name, field]) => {
    const type = field.enum ? field.enum.map(v => JSON.stringify(v)).join('|') : [field.type ?? 'any'].flat().join('|')
    const line = `  --${prefix}${name}  ${type}${required.has(name) ? ' (required)' : ''}${field.description ? `  ${field.description}` : ''}`
    return field.type === 'object' && field.properties ? [line, ...describeFields(field, `${prefix}${name}.`)] : [line]
  })
}

/** Fields the schema types as text only, so `--phone 5035550100` stays a string. */
function stringFields(schema: JsonSchema, prefix = ''): string[] {
  return Object.entries(schema.properties ?? {}).flatMap(([name, field]) =>
    field.type === 'string'
      ? [`${prefix}${name}`]
      : field.type === 'object'
        ? stringFields(field, `${prefix}${name}.`)
        : [],
  )
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const answer = await rl.question(`${question} [y/N] `)
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
}

/** Reads the key without showing it: from a terminal with echo off, else the first line of stdin. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin })
    for await (const line of rl) {
      rl.close()
      return line.trim()
    }
    return ''
  }
  process.stderr.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  let text = ''
  try {
    for await (const chunk of process.stdin) {
      for (const char of String(chunk)) {
        if (char === '\r' || char === '\n') return text.trim()
        if (char === '\u0003') throw new Failure('cancelled')
        text = char === '\u007f' ? text.slice(0, -1) : text + char
      }
    }
    return text.trim()
  } finally {
    process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stderr.write('\n')
  }
}

async function login(parsed: Parsed, io: Io) {
  const given = parsed.options.get('url')
  const stored = await readConfig()
  const url = normalizeUrl(typeof given === 'string' ? given : (stored.url ?? ''))
  const key = process.env.LINEDESK_API_KEY || (await readSecret('Personal API key (ldp_…): '))
  if (!key.startsWith('ldp_'))
    throw new Failure('a personal API key starts with ldp_ (Account settings, Personal API keys)')
  const me = (await json(await request({ url, key }, 'GET', '/v1/me'))) as { user?: { email?: string } }
  await writeConfig({ url, key })
  io.out(`Signed in to ${url}${me.user?.email ? ` as ${me.user.email}` : ''}.`)
}

async function runAction(config: Config, name: string, parsed: Parsed, io: Io) {
  const action = await findAction(config, name)
  const input = actionInput(parsed.options, new Set(stringFields(action.input)))
  if (action.destructive && parsed.options.get('yes') !== true && !(await confirm(`${name} cannot be undone. Run it?`)))
    throw new Failure(`not run: ${name} is destructive; add --yes to run it without asking`)
  const res = await request(config, 'POST', `/v1/actions/${name}`, input)
  show(io, await json(res))
}

async function get(config: Config, path: string, parsed: Parsed, io: Io) {
  if (!path.startsWith('/v1/')) throw new Failure('the path starts with /v1/, as in /v1/admin/overview')
  const res = await request(config, 'GET', path)
  if (parsed.options.get('raw') === true && res.ok) {
    process.stdout.write(new Uint8Array(await res.arrayBuffer()))
    return
  }
  show(io, await json(res))
}

export async function main(argv: readonly string[], io: Io = stdio): Promise<number> {
  const parsed = parseArgs(argv)
  const [command, ...rest] = parsed.words
  try {
    if (!command || (command === 'help' && !rest[0])) {
      io.out(USAGE)
      return 0
    }
    if (command === 'login') {
      await login(parsed, io)
      return 0
    }
    if (command === 'logout') {
      await removeConfig()
      io.out('Signed out.')
      return 0
    }
    const config = await connection(parsed)
    if (command === 'whoami' || command === 'workspaces') {
      show(io, await json(await request(config, 'GET', command === 'whoami' ? '/v1/me' : '/v1/me/workspaces')))
      return 0
    }
    if (command === 'actions') {
      const filter = rest.join(' ').toLowerCase()
      for (const a of await listActions(config))
        if (!filter || a.name.toLowerCase().includes(filter) || a.description.toLowerCase().includes(filter))
          io.out(`${a.name}${a.readOnly ? ' (read)' : ''}${a.destructive ? ' (destructive)' : ''}  ${a.description}`)
      return 0
    }
    if (command === 'help') {
      const action = await findAction(config, rest[0]!)
      io.out([`${action.name}: ${action.description}`, ...describeFields(action.input)].join('\n'))
      return 0
    }
    if (command === 'get') {
      await get(config, rest[0] ?? '', parsed, io)
      return 0
    }
    if (command === 'run' || command.includes('.')) {
      await runAction(config, command === 'run' ? (rest[0] ?? '') : command, parsed, io)
      return 0
    }
    throw new Failure(`unknown command ${command}: see \`linedesk help\``)
  } catch (e) {
    io.err(`linedesk: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}
