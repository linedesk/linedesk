// Our own proof that a partner holds the address it claims (S5, partner-domain.ts): the TXT record
// `_linedesk.<hostname>` = `linedesk-verify=<token>`, looked up with DNS over HTTPS at two public resolvers (Cloudflare
// and Google), which must both answer and both hold the value. Nothing is created at Cloudflare before that.
//
// Only these two fixed resolvers are ever asked, with the name as a query parameter: no partner-controlled URL, so no
// request can be steered to another server (no SSRF).
export const RESOLVERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'] as const
const TIMEOUT_MS = 3_000
/** DNS RR type TXT. */
const TXT = 16

type DohAnswer = { Status?: number; Answer?: { type?: number; data?: string }[] }

/** A TXT record's data as DoH JSON writes it (`"part one" "part two"`), joined to its value. */
export function txtValue(data: string): string {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]!.replace(/\\(.)/g, '$1'))
  return parts.length ? parts.join('') : data
}

/** The TXT values of a name at one resolver; [] when it has none; null when the resolver did not answer clearly. */
export async function txtAt(resolver: string, name: string, doFetch: typeof fetch = fetch): Promise<string[] | null> {
  try {
    const response = await doFetch(`${resolver}?name=${encodeURIComponent(name)}&type=TXT`, {
      headers: { accept: 'application/dns-json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return null
    const answer = (await response.json()) as DohAnswer
    // NOERROR with or without records, NXDOMAIN (the name does not exist): an answer. Anything else: no answer.
    if (answer.Status === 3) return []
    if (answer.Status !== 0) return null
    return (answer.Answer ?? []).filter(a => a.type === TXT && typeof a.data === 'string').map(a => txtValue(a.data!))
  } catch {
    return null
  }
}

/**
 * Whether `name` holds the TXT value `expected` at both resolvers: `match`, `missing` (both answered, at least one
 * without it), or `unknown` (a resolver did not answer; checked again next time).
 */
export async function txtProven(
  name: string,
  expected: string,
  doFetch: typeof fetch = fetch,
): Promise<'match' | 'missing' | 'unknown'> {
  const answers = await Promise.all(RESOLVERS.map(resolver => txtAt(resolver, name, doFetch)))
  if (answers.some(a => a === null)) return 'unknown'
  return answers.every(a => a!.includes(expected)) ? 'match' : 'missing'
}
