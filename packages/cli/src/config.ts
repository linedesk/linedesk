// Where the CLI keeps its server and key: ~/.config/linedesk/config.json (XDG_CONFIG_HOME honoured), readable by the
// user only. LINEDESK_URL and LINEDESK_API_KEY win over the file, for scripts and CI.
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Config = { url: string; key: string; workspace?: string }

export const configDir = (env: NodeJS.ProcessEnv = process.env) =>
  join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'linedesk')
export const configPath = (env: NodeJS.ProcessEnv = process.env) => join(configDir(env), 'config.json')

export async function readConfig(env: NodeJS.ProcessEnv = process.env): Promise<Partial<Config>> {
  const stored = await readFile(configPath(env), 'utf8')
    .then(text => JSON.parse(text) as Partial<Config>)
    .catch(() => ({}) as Partial<Config>)
  return {
    ...stored,
    ...(env.LINEDESK_URL ? { url: env.LINEDESK_URL } : {}),
    ...(env.LINEDESK_API_KEY ? { key: env.LINEDESK_API_KEY } : {}),
  }
}

export async function writeConfig(config: Config, env: NodeJS.ProcessEnv = process.env) {
  await mkdir(configDir(env), { recursive: true, mode: 0o700 })
  await writeFile(configPath(env), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  // writeFile keeps the mode of a file that is already there.
  await chmod(configPath(env), 0o600)
}

export const removeConfig = (env: NodeJS.ProcessEnv = process.env) => rm(configPath(env), { force: true })

/** The server's address without a trailing slash; https unless it is this machine. */
export function normalizeUrl(url: string): string {
  const parsed = new URL(url)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:'))
    throw new Error('the server address must start with https:// (http:// only for localhost)')
  return parsed.origin + parsed.pathname.replace(/\/+$/, '')
}
