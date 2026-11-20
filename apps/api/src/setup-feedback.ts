// Setup reports (LIN-208/210): an install setup link's AI agent tells the Linedesk team what went wrong, was slow or went
// well while it set the install up. It is feedback.send with `kind: setup` and `setup` (feedback.ts, LIN-639), in two
// steps on the setup MCP (setup-mcp.ts): without `user_consented` the agent gets the report exactly as it would leave,
// redacted, plus the words to ask the admin with; nothing is stored or sent. With the admin's yes it is a `feedback`
// row (with `report`) and is POSTed to SETUP_FEEDBACK_URL (the linedesk.ai endpoint of the contract, LIN-208/211), not
// emailed. The instance sends, never the agent, so the redaction always happens and one switch turns it off.
//
// Redaction, on the preview and on what is stored and sent: the values this install knows are replaced first (every
// stored provider secret and the server's own secrets from its environment, setup keys, the admin's name and its parts,
// the names of their workspaces (the businesses) and their distinctive words, their addresses and street lines, websites
// and phone numbers, the install's host), IP addresses, then scrubText (keys and tokens, phone numbers, email
// addresses). The contact address goes only into `contact.email`, and only when the admin gave it for this report.
// The preview carries a token (an HMAC of the redacted report): the yes must bring it back, and the report built again
// for sending must be the one the admin saw; a token works once per setup link. Reports are deleted after 90 days and
// with the account that made them.
//
// Sending: 5 s, no redirects; only 200/201 with `ok: true` counts as sent. A 400 is `refused` (never sent again);
// anything else (offline, timeout, a 404 or HTML page while the endpoint does not exist, 429, 5xx) is `kept` and tried
// again every hour for 7 days (the admin's yes covers those tries; jobs.ts). SETUP_FEEDBACK_URL=off sends nothing:
// reports are only kept, and the hourly retry leaves them alone (Server admin › System › Setup reports has Send again).
// A self-hosted install makes no outside request it was not asked to (github-stars.ts): each report is the admin's yes.
import {
  type AgentClient,
  agentClientLabels,
  english,
  type FeedbackKind,
  installPlace,
  providerNames,
  providerSpec,
  SETUP_KEY_PREFIX,
  SETUP_REPORT_MIN_GAP_SECONDS,
  SETUP_REPORT_SUMMARY_MAX,
  SETUP_REPORTS_PER_DAY,
  type SETUP_REPORT_CATEGORIES,
  type SETUP_REPORT_OUTCOMES,
  type SETUP_REPORT_SEVERITIES,
  installParts,
} from '@linedesk/actions'
import {
  agent_setup_keys,
  assistants,
  feedback,
  instance_settings,
  organization,
  partner_domains,
  partner_sender_domains,
  phone_numbers,
  type Tx,
  user,
} from '@linedesk/db'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { maskIpAddresses, scrubText } from '@linedesk/scrub'
import { getDomain } from 'tldts'
import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { managedWorkspaces, webAddress } from './agent-setup.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { Reject } from './handler-context.ts'
import { configOf, storedProviderValues } from './provider-settings.ts'
import { GROUP_STATE, setupChecklist } from './setup-checklist.ts'

export const SETUP_FEEDBACK_SCHEMA = 'linedesk.setup-feedback/1'
export const DEFAULT_SETUP_FEEDBACK_URL = 'https://linedesk.ai/api/setup-feedback'
/** The contract's largest body (LIN-208): a report over it is shortened before it is stored and sent. */
export const SETUP_REPORT_MAX_BYTES = 16 * 1024
/**
 * Room kept in SETUP_REPORT_MAX_BYTES for what the instance fills in at sending time, outside the preview's HMAC
 * (report_id, sent_at, `setup`: the install's few steps and the minutes). fitReport measures only the signed part, so
 * those fields moving between the preview and the yes never change how a report is cut.
 */
export const SETUP_REPORT_UNSIGNED_BYTES = 1024
/** How long kept reports are tried again (every hour), counted from the admin's yes. */
export const SETUP_REPORT_RETRY_DAYS = 7
const SEND_TIMEOUT_MS = 5_000
/** The refusal code when a setup link sent too many reports. */
export const SETUP_REPORT_RATE_LIMITED = 'setup_report_rate_limited'

/**
 * Where setup reports go: SETUP_FEEDBACK_URL, the linedesk.ai endpoint when it is empty, null when it is `off` (reports
 * are only kept). Anything but an http(s) address stops the server at start, like a wrong FEEDBACK_EMAIL.
 */
export function readSetupFeedbackUrl(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.SETUP_FEEDBACK_URL?.trim()
  if (!value) return DEFAULT_SETUP_FEEDBACK_URL
  if (value.toLowerCase() === 'off') return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`SETUP_FEEDBACK_URL ${value} is not an http(s) address or off`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`SETUP_FEEDBACK_URL ${value} is not an http(s) address or off`)
  return url.toString()
}
readSetupFeedbackUrl()

/** The running server's version: LINEDESK_VERSION, else the release deploy.sh sets (linedesk@<commit>), else unknown. */
export function serverVersion(env: Record<string, string | undefined> = process.env): string {
  const version = env.LINEDESK_VERSION?.trim() || env.SENTRY_RELEASE?.trim().replace(/^linedesk@/, '') || 'unknown'
  return version.slice(0, 40)
}

/** Linedesk Cloud's address. */
const CLOUD_HOST = 'app.linedesk.ai'
export type InstallType = 'docker' | 'dev' | 'cloud' | 'unknown'

/** How this server is installed: Linedesk Cloud, the Docker image (docker/api-entrypoint.sh says so), or pnpm dev. */
export function installType(env: Record<string, string | undefined> = process.env): InstallType {
  try {
    if (new URL(env.PUBLIC_URL ?? '').host === CLOUD_HOST) return 'cloud'
  } catch {}
  if (env.LINEDESK_INSTALL_TYPE === 'docker') return 'docker'
  if (env.NODE_ENV !== 'production') return 'dev'
  return 'unknown'
}

/** The setup page's agent names (agentClients) as the contract has them; the others are `other`. */
const CONTRACT_CLIENTS: Record<string, string> = {
  claude_code: 'claude-code',
  claude: 'claude',
  chatgpt: 'chatgpt',
  codex: 'codex',
  cursor: 'cursor',
}
export const contractClient = (client: string | null | undefined) =>
  client ? (CONTRACT_CLIENTS[client] ?? 'other') : 'unknown'
/** The setup page's agent for a report's agent name (`other` stays other; `unknown` is null). */
export function agentClientOf(contract: string | null | undefined): AgentClient | null {
  const found = Object.entries(CONTRACT_CLIENTS).find(([, name]) => name === contract)?.[0]
  return (found as AgentClient | undefined) ?? (contract === 'other' ? 'other' : null)
}

const INSTALL_REF_KEY = 'setup_feedback.install_ref'
const hex20 = () => crypto.randomUUID().replaceAll('-', '').slice(0, 20)

/** This install's random reference (`ir_` + 20 hex): made once, kept only here, so reports of one install group. */
async function installRef(tx: Tx): Promise<string> {
  await tx
    .insert(instance_settings)
    .values({ key: INSTALL_REF_KEY, value: `ir_${hex20()}` })
    .onConflictDoNothing()
  const [row] = await tx.select().from(instance_settings).where(eq(instance_settings.key, INSTALL_REF_KEY))
  return row!.value
}

export type SetupReportItem = {
  category: (typeof SETUP_REPORT_CATEGORIES)[number]
  step?: string
  tool?: string
  what_happened: string
  expected?: string
  time_lost_minutes?: number
  severity: (typeof SETUP_REPORT_SEVERITIES)[number]
  error_code?: string
  error_excerpt?: string
}
/** What the agent sends (feedback.send's input, the setup link's part). */
export type SetupReportInput = {
  kind: FeedbackKind
  text: string
  contact_email?: string
  setup?: { outcome: (typeof SETUP_REPORT_OUTCOMES)[number]; items?: SetupReportItem[]; agent_model?: string }
  user_consented?: boolean
  preview_token?: string
}
/** The JSON that leaves the install (contract v1, LIN-208). */
export type SetupReport = {
  schema: typeof SETUP_FEEDBACK_SCHEMA
  report_id: string
  sent_at: string
  source: 'agent'
  install: { install_ref: string; version: string; install_type: InstallType; public: boolean }
  agent: { client: string; model?: string }
  setup: { current_step: string | null; steps: Record<string, string>; minutes_since_start: number }
  outcome: string
  summary?: string
  items: SetupReportItem[]
  contact?: { email: string }
}

/**
 * One value the install knows, and what it becomes in a report. `anywhere`: also inside a longer word (secrets);
 * `pattern`: matched by its own pattern (phone numbers in every way they are written, domains with subdomains).
 */
type Known = {
  value: string
  as: string
  caseSensitive?: boolean
  anywhere?: boolean
  pattern?: RegExp
  /** A name part under MIN_KNOWN_LENGTH ("Tim"): kept down to MIN_NAME_PART_LENGTH. */
  short?: boolean
}

const MIN_KNOWN_LENGTH = 4
/** A part of the admin's name shorter than MIN_KNOWN_LENGTH ("Tim") still goes, as a whole word written as in the name. */
const MIN_NAME_PART_LENGTH = 2
/**
 * Words of a business name (or short name parts) that are not redacted on their own: common English and German words,
 * business forms and trades, and the setup's own words. "Brightwater" in "Brightwater Plumbing & Heating" goes; "the
 * heating step" stays. The whole name always goes (`[business]`).
 */
const COMMON_WORDS = new Set(
  // i18n-ignore: a word list for redaction, never shown
  (
    'a an and are as at be but by can did do for from get go had has he her him his how if in is it its let me my no ' +
    'not now of off on one or our out own put run say see set she so the to too two up us use was way we who why yes ' +
    'yet you all any few got key log new old url api app ' +
    'also back been best call calls care center centre city club company corp corporation country data design ' +
    'east first free from full group have here home house into just limited llc ltd main more most much ' +
    'national north office online over partners plus professional real service services shop solutions south ' +
    'store studio support systems team test that them then there they this time trust usa very west what when ' +
    'where which will with work works world your ' +
    'auto bakery cafe clinic cleaning construction consulting dental dentist electric electrical garden hair ' +
    'heating health insurance kitchen law legal medical motors painting pest pets plumbing realty repair repairs ' +
    'restaurant roofing salon spa therapy tours travel ' +
    'aber auch beim bitte dass dein denn der des die das dem den ein eine einen einer eines für gmbh haus ' +
    'ich ist mit nach nicht noch oder sich sind und von vom wie wir zum zur ' +
    'admin agent assistant business calendar carrier email linedesk number phone server setup step workspace'
  ).split(/\s+/),
)
/** The distinctive words of a business name: 4+ letters and not a common word. */
const businessWords = (name: string) =>
  name.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= MIN_KNOWN_LENGTH && !COMMON_WORDS.has(w.toLowerCase()))
/** The street line of an address: what comes before the first comma ("1234 SE Main St, Portland, OR" → "1234 SE Main St"). */
const streetLine = (address: string) => {
  const street = address.split(',')[0]!.trim()
  return street.length >= MIN_KNOWN_LENGTH && street !== address.trim() ? street : null
}
/** A secret shorter than this is not matched on its own: too many ordinary words would go with it. */
const MIN_SECRET_LENGTH = 8
/** Environment variables that hold secrets, by name (BETTER_AUTH_SECRET, S3_SECRET_ACCESS_KEY, VAPID_PRIVATE_KEY, …). */
const SECRET_ENV_NAME = /SECRET|PASSWORD|TOKEN|PRIVATE_KEY|_KEY$/
/** Values such a variable has that are no secret. */
const NOT_A_SECRET = /^(?:true|false|on|off|yes|no|none|disabled|enabled|0|1)$/i

const decoded = (value: string) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Every way a secret may be typed into a report: as stored, trimmed, without its spaces (a Gmail app password is shown
 * in groups of four), percent-encoded and decoded, and for a URL with credentials (SMTP, DATABASE_URL) its user and
 * password on their own.
 */
export function secretVariants(value: string): string[] {
  const variants = new Set<string>()
  const add = (v: string) => {
    for (const form of [v, v.trim(), v.replace(/\s+/g, ''), encodeURIComponent(v.trim()), decoded(v.trim())])
      if (form.length >= MIN_SECRET_LENGTH && !NOT_A_SECRET.test(form)) variants.add(form)
  }
  add(value)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()))
    try {
      const url = new URL(value.trim())
      if (url.password) add(decoded(url.password))
      if (url.password) add(url.password)
      // The user only when it looks like a key (SMTP users are often API key ids): never a plain name.
      if (url.username && /\d/.test(url.username)) add(decoded(url.username))
    } catch {}
  return [...variants]
}

/** Every provider value the install has stored or reads from its environment that is a secret. */
async function providerConfigs(tx: Tx) {
  const { rows, links } = await storedProviderValues(tx)
  return providerNames.flatMap(provider => {
    try {
      return [{ provider, config: configOf(provider, rows, links.get(provider) ?? null) }]
    } catch {
      // A value that cannot be decrypted (wrong SECRETS_KEY) cannot be typed by the agent either.
      return []
    }
  })
}

/** The server's own secrets: every variable named like one, and the credentials in any URL-shaped variable. */
function envSecrets(env: Record<string, string | undefined>): string[] {
  return Object.entries(env).flatMap(([name, value]) => {
    if (!value) return []
    if (SECRET_ENV_NAME.test(name)) return [value]
    // DATABASE_URL, SMTP_URL, …: the password (and a key-like user) inside.
    return /^[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(value.trim()) ? secretVariants(value).filter(v => v !== value) : []
  })
}

/** A domain and every subdomain of it, as a whole name (`brightwater.example`, `mail.brightwater.example`). */
const domainKnown = (domain: string): Known | null => {
  const d = domain.trim().toLowerCase().replace(/\.$/, '')
  if (!d.includes('.') || d.length < MIN_KNOWN_LENGTH) return null
  return {
    value: d,
    as: '[domain]',
    pattern: new RegExp(`(?<![\\w.-])(?:[\\w-]+\\.)*${escapeRegExp(d)}(?![\\w-]|\\.\\w)`, 'gi'),
  }
}
/** A host and its registrable domain (`app.linedesk.ai` → also `linedesk.ai`). */
const hostKnown = (host: string | null | undefined): Known[] => {
  if (!host) return []
  const h = host.toLowerCase()
  return [domainKnown(h), domainKnown(getDomain(h, { allowPrivateDomains: true }) ?? h)].filter(
    (k): k is Known => k !== null,
  )
}
const hostOfUrl = (url: string | null | undefined) => {
  try {
    return url ? new URL(url.trim()).hostname : null
  } catch {
    return null
  }
}
/** An email From value (`Brightwater <hi@brightwater.example>`): its domain, and its display name. */
const fromKnown = (from: string | null | undefined): Known[] => {
  if (!from?.trim()) return []
  const address = from.match(/[^\s<>@]+@([^\s<>@]+)/)
  const display = from
    .replace(/<[^>]*>/, '')
    .replace(/[\s"']+/g, ' ')
    .trim()
  return [
    ...(address?.[1] ? hostKnown(address[1]) : []),
    ...(display && !display.includes('@') ? [{ value: display, as: '[name]' }] : []),
  ]
}

/**
 * A phone number in every way it is written: international (+49 …, 0049 …, 49 …), national with its trunk 0
 * (06221 5550147, 06221/5550147) or without, with any separators. Matched on its digits, never inside a longer number.
 */
export function phonePattern(number: string): RegExp | null {
  const digits = number.replace(/\D/g, '')
  if (digits.length < 6) return null
  const sep = '[\\s./()-]*'
  const spell = (d: string) => d.split('').join(sep)
  // An E.164 number's country code is 1 to 3 digits: each split, its national part with an optional prefix.
  const forms = number.trim().startsWith('+')
    ? [1, 2, 3].map(cc => {
        const code = digits.slice(0, cc)
        const national = digits.slice(cc).replace(/^0/, '')
        return `(?:(?:(?:\\+|00)${sep})?${spell(code)}${sep}(?:\\(0\\)${sep})?|0${sep})?\\(?${spell(national)}`
      })
    : [`(?:0${sep})?\\(?${spell(digits.replace(/^0/, ''))}`]
  return new RegExp(`(?<!\\d)(?:${forms.join('|')})(?!\\d)`, 'g')
}
const phoneKnown = (number: string | null | undefined): Known[] => {
  const pattern = number ? phonePattern(number) : null
  return pattern ? [{ value: number!, as: '[phone]', pattern }] : []
}

/**
 * What this install knows that must never leave in a report: secrets (provider keys, the server's own, in every form
 * they may be typed), the admin's name and email, their workspaces' names, addresses, websites and phone numbers, the
 * install's host and domain, the email sender's domain and name, the SMTP host, and the partners' own domains.
 */
export async function knownValues(
  tx: Tx,
  actor: Pick<Actor, 'actorId'>,
  env: Record<string, string | undefined> = process.env,
): Promise<Known[]> {
  const known: Known[] = []
  const secret = (value: string) => {
    for (const v of secretVariants(value)) known.push({ value: v, as: '[secret]', anywhere: true })
  }
  for (const { provider, config } of await providerConfigs(tx)) {
    for (const [field, spec] of Object.entries(providerSpec(provider).fields)) {
      const value = config[field]?.value
      if (!value) continue
      if (spec.secret) secret(value)
      // The email provider's From and any server address in a provider value (the SMTP host).
      if (field === 'from') known.push(...fromKnown(value))
      known.push(...hostKnown(/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) ? hostOfUrl(value) : null))
    }
  }
  for (const value of envSecrets(env)) secret(value)
  known.push(...fromKnown(env.EMAIL_FROM))
  const [admin] = await tx.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, actor.actorId))
  if (admin?.email) known.push({ value: admin.email, as: '[email]' })
  if (admin?.name) {
    known.push({ value: admin.name, as: '[name]' })
    // Each part of the name on its own, as written and as a whole word (so "Mike" and "Tim" go, "mike" or "tim" in a
    // sentence about something else stays); a short part that is a common word ("Do", "An") never.
    for (const part of admin.name.split(/\s+/)) {
      const short = part.length < MIN_KNOWN_LENGTH
      if (short && (!/^\p{L}+$/u.test(part) || COMMON_WORDS.has(part.toLowerCase()))) continue
      known.push({ value: part, as: '[name]', caseSensitive: true, short })
    }
  }
  // The workspaces the admin may set up (owner or admin; setupWorkspaces in agent-setup.ts).
  const workspaceIds = (await managedWorkspaces(actor.actorId)).map(w => w.id)
  if (workspaceIds.length) {
    const orgs = await tx
      .select({ name: organization.name })
      .from(organization)
      .where(inArray(organization.id, workspaceIds))
    for (const org of orgs) {
      known.push({ value: org.name, as: '[business]' })
      // Its distinctive words on their own ("Brightwater"), also when the agent shortened or reordered the name.
      for (const word of businessWords(org.name)) known.push({ value: word, as: '[business]' })
    }
    const profiles = await tx
      .select({ profile: assistants.business_profile })
      .from(assistants)
      .where(inArray(assistants.workspace_id, workspaceIds))
    // The business's address, website and own number (business_profile; its name is the workspace's).
    for (const { profile } of profiles) {
      if (profile?.address) {
        known.push({ value: profile.address, as: '[address]' })
        const street = streetLine(profile.address)
        if (street) known.push({ value: street, as: '[address]' })
      }
      known.push(...phoneKnown(profile?.phone))
      known.push(...hostKnown(hostOfUrl(profile?.website)))
    }
    const numbers = await tx
      .select({ e164: phone_numbers.e164 })
      .from(phone_numbers)
      .where(inArray(phone_numbers.workspace_id, workspaceIds))
    for (const { e164 } of numbers) known.push(...phoneKnown(e164))
  }
  // The partners' own addresses and sender domains (white-label): customers' names in a domain.
  for (const { hostname } of await tx.select({ hostname: partner_domains.hostname }).from(partner_domains))
    known.push(...hostKnown(hostname))
  for (const { domain } of await tx.select({ domain: partner_sender_domains.domain }).from(partner_sender_domains))
    known.push(...hostKnown(domain))
  known.push(...hostKnown(hostOfUrl(webAddress())))
  // Longest first, so a name inside a longer value does not break the longer one's match.
  return known
    .filter(k => k.value.trim().length >= (k.short ? MIN_NAME_PART_LENGTH : MIN_KNOWN_LENGTH))
    .sort((a, b) => b.value.length - a.value.length)
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/**
 * A known value as a pattern: its own, or the value as a whole word (secrets anywhere). Word edges count letters of
 * every language ("Jürgen" not inside "Jürgensen"), not only ASCII.
 */
const patternOf = ({ value, caseSensitive, anywhere, pattern }: Known) => {
  if (pattern) return pattern
  const body = escapeRegExp(value.trim())
  const start = !anywhere && /^[\p{L}\p{N}_]/u.test(value.trim()) ? '(?<![\\p{L}\\p{N}_])' : ''
  const end = !anywhere && /[\p{L}\p{N}_]$/u.test(value.trim()) ? '(?![\\p{L}\\p{N}_])' : ''
  return new RegExp(`${start}${body}${end}`, caseSensitive ? 'gu' : 'giu')
}
/** Any setup key, also a cut one (the raw key is not stored, so it is matched by its shape). */
const SETUP_KEY = new RegExp(`${escapeRegExp(SETUP_KEY_PREFIX)}[A-Za-z0-9_-]{8,}`, 'g')

const replaceKnown = (text: string, known: readonly Known[]) =>
  known.reduce((out, k) => out.replace(patternOf(k), k.as), text)

/**
 * A free text as it may leave, cut to `max`: setup keys and the secrets the install knows first, then IP addresses,
 * then the tokens, phone numbers and email addresses scrubText finds, then every known value, then scrubText once more.
 */
export function redactText(text: string, known: readonly Known[], max: number): string {
  let out = text.replace(SETUP_KEY, '[key]')
  out = replaceKnown(
    out,
    known.filter(k => k.anywhere),
  )
  out = scrubText(maskIpAddresses(out))
  out = scrubText(replaceKnown(out, known))
  return out.length > max ? `${out.slice(0, max - 1)}…` : out
}

/** Every free text of a report redacted and cut to the contract's limits; the enums and numbers as given. */
export function redactReport(report: SetupReport, known: readonly Known[]): SetupReport {
  const text = (value: string | undefined, max: number) => (value ? redactText(value, known, max) : undefined)
  const items = report.items.map(
    item =>
      Object.fromEntries(
        Object.entries({
          category: item.category,
          step: text(item.step, 40),
          tool: text(item.tool, 60),
          what_happened: text(item.what_happened, 1000) || '[redacted]',
          expected: text(item.expected, 500),
          time_lost_minutes: item.time_lost_minutes,
          severity: item.severity,
          error_code: text(item.error_code, 60),
          error_excerpt: text(item.error_excerpt, 500),
        }).filter(([, v]) => v !== undefined && v !== ''),
      ) as SetupReportItem,
  )
  const summary = text(report.summary, SETUP_REPORT_SUMMARY_MAX)
  const model = text(report.agent.model, 80)
  return {
    ...report,
    agent: { client: report.agent.client, ...(model ? { model } : {}) },
    ...(summary ? { summary } : {}),
    items,
  }
}

/**
 * What the admin says yes to: the redacted report without what the instance fills in at sending time (report_id,
 * sent_at, and `setup`, the steps' states and minutes, which may move between the preview and the yes).
 */
const consentedPart = (report: SetupReport) => {
  const { report_id: _id, sent_at: _at, setup: _setup, ...rest } = report
  return rest
}

/**
 * A report over the contract's 16 KB: the long texts shortened, then the last items dropped, until it fits. Ten items
 * at their longest are about 25 KB; most reports are far below. Measured on the part the preview's HMAC covers, plus
 * SETUP_REPORT_UNSIGNED_BYTES for the rest, so the preview and the send are always cut the same way.
 */
export function fitReport(report: SetupReport): SetupReport {
  const size = (r: SetupReport) => Buffer.byteLength(JSON.stringify(consentedPart(r))) + SETUP_REPORT_UNSIGNED_BYTES
  if (size(report) <= SETUP_REPORT_MAX_BYTES) return report
  const cut = (value: string | undefined, max: number) =>
    value && value.length > max ? `${value.slice(0, max - 1)}…` : value
  let fitted: SetupReport = {
    ...report,
    items: report.items.map(item => {
      const expected = cut(item.expected, 200)
      const excerpt = cut(item.error_excerpt, 200)
      return {
        ...item,
        what_happened: cut(item.what_happened, 500)!,
        ...(expected ? { expected } : {}),
        ...(excerpt ? { error_excerpt: excerpt } : {}),
      }
    }),
  }
  while (size(fitted) > SETUP_REPORT_MAX_BYTES && fitted.items.length)
    fitted = { ...fitted, items: fitted.items.slice(0, -1) }
  return fitted
}

/** The install's steps (the server's part, as setup_status lists them) and the first one still open. */
async function setupSteps(tx: Tx) {
  const { groups } = await setupChecklist(tx)
  const steps: Record<string, string> = {}
  for (const id of installParts) {
    const group = groups.find(g => g.id === id)
    if (group) steps[id] = GROUP_STATE[group.state]
  }
  const current = Object.entries(steps).find(([, state]) => state !== 'done')?.[0] ?? null
  return { steps, current }
}

/**
 * The report as it would leave now, redacted: what the agent wrote plus what the instance fills in itself (version,
 * install type and reference, the steps' states, minutes since the link was made, the agent the admin picked).
 */
export async function buildSetupReport(
  tx: Tx,
  actor: Actor,
  input: SetupReportInput,
  { reportId = `sf_${hex20()}`, now = new Date().toISOString() }: { reportId?: string; now?: string } = {},
): Promise<SetupReport> {
  const [key] = actor.setupKeyId
    ? await tx
        .select({ client: agent_setup_keys.client, created_at: agent_setup_keys.created_at })
        .from(agent_setup_keys)
        .where(eq(agent_setup_keys.id, actor.setupKeyId))
    : []
  const minutes = key ? Math.round((Date.parse(now) - Date.parse(key.created_at)) / 60_000) : 0
  const { steps, current } = await setupSteps(tx)
  const setup = input.setup ?? { outcome: 'in_progress' as const }
  const report: SetupReport = {
    schema: SETUP_FEEDBACK_SCHEMA,
    report_id: reportId,
    sent_at: now,
    source: 'agent',
    install: {
      install_ref: await installRef(tx),
      version: serverVersion(),
      install_type: installType(),
      public: installPlace(webAddress()) === 'public',
    },
    agent: { client: contractClient(key?.client), ...(setup.agent_model ? { model: setup.agent_model } : {}) },
    setup: { current_step: current, steps, minutes_since_start: Math.min(1440, Math.max(0, minutes)) },
    outcome: setup.outcome,
    summary: input.text,
    items: setup.items ?? [],
    ...(input.contact_email ? { contact: { email: input.contact_email } } : {}),
  }
  return fitReport(redactReport(report, await knownValues(tx, actor)))
}

/**
 * What the agent says to the admin before sending (LIN-208's consent text), from the redacted report: one line per
 * item. Words for the agent, which says them in the admin's language.
 */
export function consentText(report: SetupReport): string {
  const t = english.t
  const client = agentClientOf(report.agent.client)
  const agent = client && client !== 'other' ? agentClientLabels[client] : t('server.setupAgent.report.anAgent')
  const line = (text: string) => (text.length > 160 ? `${text.slice(0, 159)}…` : text)
  const lines = report.items.length
    ? report.items.map(item =>
        item.time_lost_minutes
          ? t('server.setupAgent.report.consentItemMinutes', {
              text: line(item.what_happened),
              minutes: item.time_lost_minutes,
            })
          : t('server.setupAgent.report.consentItem', { text: line(item.what_happened) }),
      )
    : [
        t('server.setupAgent.report.consentItem', {
          text: line(report.summary ?? t('server.setupAgent.report.consentWentWell')),
        }),
      ]
  return [
    t('server.setupAgent.report.consentIntro'),
    '',
    ...lines,
    '',
    t('server.setupAgent.report.consentIncludes', { agent }),
    report.contact
      ? t('server.setupAgent.report.consentSendContact', { email: report.contact.email })
      : t('server.setupAgent.report.consentSend'),
  ].join('\n')
}

/** How long a preview's token is good for: the admin's yes comes right after the preview. */
export const PREVIEW_TOKEN_TTL_MS = 60 * 60_000
const PREVIEW_TOKEN_PREFIX = 'pt1'

/** JSON with every object's keys sorted, so the same report always gives the same text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** HMAC over the setup link and the expiry and the consented part, keyed from BETTER_AUTH_SECRET (agent-token.ts too). */
function previewMac(
  setupKeyId: string,
  expiresAt: number,
  report: SetupReport,
  env: Record<string, string | undefined>,
) {
  const secret = env.BETTER_AUTH_SECRET
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set: setup report previews cannot be signed')
  const key = createHmac('sha256', secret).update('linedesk setup report preview v1').digest()
  return createHmac('sha256', key)
    .update(`${setupKeyId}\n${expiresAt}\n${canonicalJson(consentedPart(report))}`)
    .digest('base64url')
}

/**
 * The preview's token (security review F7): the send with the admin's yes must carry it, and the server builds the
 * report again and sends it only when it is the one the admin saw. Bound to the setup link, good for an hour.
 */
export function previewToken(
  setupKeyId: string,
  report: SetupReport,
  nowMs = Date.now(),
  env: Record<string, string | undefined> = process.env,
): string {
  const expiresAt = nowMs + PREVIEW_TOKEN_TTL_MS
  return `${PREVIEW_TOKEN_PREFIX}.${expiresAt}.${previewMac(setupKeyId, expiresAt, report, env)}`
}

/** Whether `token` is this link's unexpired token for exactly this redacted report. Never throws on bad input. */
export function previewTokenMatches(
  token: string | undefined,
  setupKeyId: string,
  report: SetupReport,
  nowMs = Date.now(),
  env: Record<string, string | undefined> = process.env,
): boolean {
  const [prefix, expires, mac, ...rest] = (token ?? '').split('.')
  // The expiry only as previewToken writes it (no leading zero), so one token has one spelling.
  if (prefix !== PREVIEW_TOKEN_PREFIX || !expires || !mac || rest.length || !/^[1-9]\d*$/.test(expires)) return false
  const expiresAt = Number(expires)
  if (expiresAt < nowMs || expiresAt > nowMs + PREVIEW_TOKEN_TTL_MS) return false
  const want = Buffer.from(previewMac(setupKeyId, expiresAt, report, env))
  const got = Buffer.from(mac)
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * What a used preview token is kept as on its report (feedback.preview_token_hash): the SHA-256 of its canonical form
 * (the expiry as a plain number), never the token, so another spelling of the same token is the same used token.
 */
export function previewTokenHash(token: string): string {
  const [prefix, expires, mac, ...rest] = token.split('.')
  const canonical =
    prefix === PREVIEW_TOKEN_PREFIX && expires && /^\d+$/.test(expires) && mac && !rest.length
      ? `${PREVIEW_TOKEN_PREFIX}.${Number(expires)}.${mac}`
      : token
  return createHash('sha256').update(canonical).digest('hex')
}

/** Holds the setup link's lock until the transaction ends, so two sends on one link are checked one after the other. */
export const lockSetupLink = (tx: Tx, setupKeyId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`setup-feedback:${setupKeyId}`}))`)

/**
 * Refuses a yes whose preview_token already went out with a report of this setup link (a token works once). Checked
 * before the rate limits, and it stores nothing, so a refused send never counts toward them. Call with the link locked.
 */
export async function checkPreviewTokenUnused(tx: Tx, setupKeyId: string, token: string | undefined) {
  if (!token) return
  const [used] = await tx
    .select({ id: feedback.id })
    .from(feedback)
    .where(and(eq(feedback.setup_key_id, setupKeyId), eq(feedback.preview_token_hash, previewTokenHash(token))))
    .limit(1)
  if (used) throw Reject.t('server.api.feedback.setupPreviewUsed')
}

/** Refuses a setup link's report past its limits (per link: SETUP_REPORTS_PER_DAY, one per SETUP_REPORT_MIN_GAP_SECONDS). */
export async function checkSetupReportRate(tx: Tx, setupKeyId: string, now: string) {
  await lockSetupLink(tx, setupKeyId)
  const dayAgo = new Date(Date.parse(now) - 24 * 3_600_000).toISOString()
  const [recent] = await tx
    .select({ count: sql<number>`count(*)::int`, last: sql<string | null>`max(${feedback.created_at})` })
    .from(feedback)
    .where(and(eq(feedback.setup_key_id, setupKeyId), gt(feedback.created_at, dayAgo)))
  if ((recent?.count ?? 0) >= SETUP_REPORTS_PER_DAY)
    throw Reject.t('server.api.feedback.setupTooMany', { count: SETUP_REPORTS_PER_DAY }, SETUP_REPORT_RATE_LIMITED)
  const last = recent?.last ? Date.parse(recent.last) : null
  if (last !== null && Date.parse(now) - last < SETUP_REPORT_MIN_GAP_SECONDS * 1000)
    throw Reject.t(
      'server.api.feedback.setupTooSoon',
      { seconds: SETUP_REPORT_MIN_GAP_SECONDS },
      SETUP_REPORT_RATE_LIMITED,
    )
}

/** How one try to send went. */
export type SendResult =
  | { status: 'sent'; remoteId: string }
  | { status: 'kept'; error: string }
  | { status: 'refused'; error: string }

const short = (text: string) => scrubText(text).slice(0, 300)

/** The most of the endpoint's answer that is read (security review F9): its JSON is a few fields. */
export const MAX_ANSWER_BYTES = 64 * 1024

/**
 * The endpoint's answer as JSON, read up to MAX_ANSWER_BYTES: a larger content-length is not read at all, a body that
 * grows past it is cancelled. Null when it is too large or not JSON.
 */
async function readAnswer(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) return null
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_ANSWER_BYTES) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

/**
 * POSTs a report to the endpoint: 5 s, no redirect followed. Only 200/201 with JSON `ok: true` and an id is sent; a 400
 * is refused (the report is invalid there, sending it again would not help); everything else is kept.
 */
export async function postReport(
  url: string,
  report: SetupReport,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'linedesk' },
      body: JSON.stringify(report),
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  } catch (e) {
    const host = new URL(url).host
    const timedOut = e instanceof Error && e.name === 'TimeoutError'
    return {
      status: 'kept',
      error: english.t(timedOut ? 'server.setupAgent.report.errorTimeout' : 'server.setupAgent.report.errorConnect', {
        host,
      }),
    }
  }
  const answer = await readAnswer(res)
  const body = answer && typeof answer === 'object' ? (answer as { ok?: unknown; id?: unknown; error?: unknown }) : null
  if ((res.status === 200 || res.status === 201) && body?.ok === true && typeof body.id === 'string')
    return { status: 'sent', remoteId: body.id.slice(0, 80) }
  if (res.status === 400)
    return {
      status: 'refused',
      error: short(
        english.t('server.setupAgent.report.errorRefused', {
          error: typeof body?.error === 'string' ? body.error : 'invalid',
        }),
      ),
    }
  const status = res.status
  if (status >= 300 && status < 400)
    return { status: 'kept', error: english.t('server.setupAgent.report.errorRedirect', { status }) }
  if (!body) return { status: 'kept', error: english.t('server.setupAgent.report.errorNotEndpoint', { status }) }
  return {
    status: 'kept',
    error: short(
      typeof body.error === 'string'
        ? english.t('server.setupAgent.report.errorHttpWith', { status, error: body.error })
        : english.t('server.setupAgent.report.errorHttp', { status }),
    ),
  }
}

/** The shortest time between two tries of one report (a Send again right after a try waits). */
export const CLAIM_GAP_MS = 60_000

/** last_error of a report kept while sending is off: a marker, never shown as text (setup-mcp.ts, Setup reports). */
export const SENDING_OFF = 'SETUP_FEEDBACK_URL=off'

/**
 * Sends a stored setup report once and records how it went (status, remote id, tries). With SETUP_FEEDBACK_URL=off it
 * stays kept and no try is counted. Returns the row as it is afterwards, or null when there is no such setup report.
 */
export async function deliverSetupReport(id: string, fetchImpl: typeof fetch = fetch) {
  const [row] = await db
    .select()
    .from(feedback)
    .where(and(eq(feedback.id, id), isNotNull(feedback.report)))
  if (!row?.report || row.status === 'sent') return row ?? null
  const url = readSetupFeedbackUrl()
  if (!url) {
    const [kept] = await db
      .update(feedback)
      .set({ status: 'kept', last_error: SENDING_OFF })
      .where(eq(feedback.id, id))
      .returning()
    return kept!
  }
  const now = new Date().toISOString()
  // Claimed in one statement, so Send again, the hourly retry and a second API process never send it twice at once:
  // only a pending or kept report not tried in the last minute; the try's time is set at once.
  const [claimed] = await db
    .update(feedback)
    .set({ status: 'pending', tried_at: now })
    .where(
      and(
        eq(feedback.id, id),
        isNotNull(feedback.report),
        inArray(feedback.status, ['pending', 'kept']),
        or(isNull(feedback.tried_at), lt(feedback.tried_at, new Date(Date.parse(now) - CLAIM_GAP_MS).toISOString())),
      ),
    )
    .returning()
  if (!claimed) return row
  const report = { ...(claimed.report as SetupReport), sent_at: now }
  const result = await postReport(url, report, fetchImpl)
  const [after] = await db
    .update(feedback)
    .set({
      report,
      tries: sql`${feedback.tries} + 1`,
      tried_at: now,
      ...(result.status === 'sent'
        ? { status: 'sent', remote_id: result.remoteId, sent_at: now, last_error: null }
        : { status: result.status, last_error: result.error }),
    })
    .where(eq(feedback.id, id))
    .returning()
  if (result.status !== 'sent') console.warn(`setup report ${id}: ${result.status}: ${result.error}`)
  return after!
}

/**
 * The hourly retry (jobs.ts): kept setup reports that were tried before and not in the last 55 minutes, made in the
 * last 7 days, and ones still pending 10 minutes after the yes (the server stopped in between). Never with sending
 * off, never a refused one.
 */
export async function retryKeptSetupReports(now = Date.now(), fetchImpl: typeof fetch = fetch) {
  if (!readSetupFeedbackUrl()) return { tried: 0 }
  const iso = (ms: number) => new Date(ms).toISOString()
  const due = await db
    .select({ id: feedback.id })
    .from(feedback)
    .where(
      and(
        isNotNull(feedback.report),
        gt(feedback.created_at, iso(now - SETUP_REPORT_RETRY_DAYS * 24 * 3_600_000)),
        or(
          and(eq(feedback.status, 'kept'), gt(feedback.tries, 0), lt(feedback.tried_at, iso(now - 55 * 60_000))),
          and(eq(feedback.status, 'pending'), lt(feedback.created_at, iso(now - 10 * 60_000))),
        ),
      ),
    )
    .limit(100)
  for (const { id } of due) await deliverSetupReport(id, fetchImpl).catch(e => console.error(`setup report ${id}:`, e))
  return { tried: due.length }
}

/** How long a setup report is kept on the install (security review F10): sent, kept or refused alike. */
export const SETUP_REPORT_KEEP_DAYS = 90

/** Hourly (jobs.ts, with the retry): setup reports older than SETUP_REPORT_KEEP_DAYS go. How many went. */
export async function pruneOldSetupReports(now = Date.now()) {
  const before = new Date(now - SETUP_REPORT_KEEP_DAYS * 24 * 3_600_000).toISOString()
  const gone = await db
    .delete(feedback)
    .where(and(eq(feedback.kind, 'setup'), isNull(feedback.workspace_id), lt(feedback.created_at, before)))
    .returning({ id: feedback.id })
  return gone.length
}

/**
 * The hourly setup-reports job (jobs.ts): the retry and the 90-day delete run each on their own, so one failing never
 * skips the other; a failure is logged and the job still finishes.
 */
export async function runSetupFeedbackJob({
  retry = () => retryKeptSetupReports(),
  prune = () => pruneOldSetupReports(),
}: {
  retry?: () => Promise<{ tried: number }>
  prune?: () => Promise<number>
} = {}) {
  const tried = await retry().then(
    r => r.tried,
    e => (console.error('setup reports: the retry failed:', e), null),
  )
  const pruned = await prune().catch(e => (console.error('setup reports: deleting old ones failed:', e), null))
  return { tried, pruned }
}
