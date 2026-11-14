// One-click unsubscribe from setup emails (RFC 8058), without signing in. Every setup email to an owner carries a
// link signed for that owner and workspace (HMAC with a key derived from SECRETS_KEY, no expiry: an old email must
// still work), in its footer and in the List-Unsubscribe header.
//
// A public route outside the action registry, like the sign-in and webhook routes: the person who clicks has no
// session, and mail providers POST to it on their own. The signed token is the only authority, and it can do one
// thing: set setup_emails = false for that member of that workspace. It reads nothing back and changes nothing else.
// It sits under /api (not /v1), so the cookie-based cross-site check of /v1 doesn't refuse a signed-in browser.
import { member, member_notification_settings } from '@linedesk/db'
import { timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import type { Env, Hono } from 'hono'
import { brandName } from './branding.ts'
import { db } from './db.ts'
import { WEB_ORIGIN } from './emails/templates.ts'
import { hasSecretsKey, signWithSecretsKey } from './secrets.ts'

const PURPOSE = 'setup-emails-unsubscribe'
export const SETUP_UNSUBSCRIBE_PATH = '/api/unsubscribe/setup'

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url')
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8')
const signed = (workspaceId: string, userId: string) => signWithSecretsKey(PURPOSE, `${workspaceId}\n${userId}`)

/** The token for one member of one workspace: base64url(workspace).base64url(user).hmac. */
export const setupUnsubscribeToken = (workspaceId: string, userId: string) =>
  `${b64(workspaceId)}.${b64(userId)}.${signed(workspaceId, userId)}`

/** Who a token is for, or null when it is malformed, tampered with, or this install has no SECRETS_KEY. */
export function readSetupUnsubscribeToken(token: string | undefined): { workspaceId: string; userId: string } | null {
  const parts = (token ?? '').split('.')
  if (parts.length !== 3 || !hasSecretsKey()) return null
  const [ws, us, mac] = parts as [string, string, string]
  if (!/^[0-9a-f]{64}$/.test(mac) || !/^[\w-]+$/.test(ws) || !/^[\w-]+$/.test(us)) return null
  const workspaceId = unb64(ws)
  const userId = unb64(us)
  if (!workspaceId || !userId || b64(workspaceId) !== ws || b64(userId) !== us) return null
  if (!timingSafeEqual(Buffer.from(signed(workspaceId, userId)), Buffer.from(mac))) return null
  return { workspaceId, userId }
}

/** The one-click link for a member, or null without SECRETS_KEY (the emails then link to the signed-in setting). */
export function setupUnsubscribeUrl(workspaceId: string, userId: string, origin = WEB_ORIGIN): string | null {
  if (!hasSecretsKey()) return null
  return `${origin}${SETUP_UNSUBSCRIBE_PATH}?t=${setupUnsubscribeToken(workspaceId, userId)}`
}

/** The headers mail apps show an Unsubscribe button for, POSTing without a confirm page (RFC 8058). */
export const unsubscribeHeaders = (url: string) => ({
  'List-Unsubscribe': `<${url}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
})

/** Turns setup emails off for that member; repeating it changes nothing. False when they are no member (any more). */
export async function unsubscribeFromSetupEmails(workspaceId: string, userId: string): Promise<boolean> {
  const [membership] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, workspaceId), eq(member.userId, userId)))
  if (!membership) return false
  await db
    .insert(member_notification_settings)
    .values({ workspace_id: workspaceId, user_id: userId, setup_emails: false })
    .onConflictDoUpdate({
      target: [member_notification_settings.workspace_id, member_notification_settings.user_id],
      set: { setup_emails: false, updated_at: new Date().toISOString() },
    })
  return true
}

const htmlEscape = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

/** A plain page: the CSP allows no inline styles or scripts, and none are needed. */
function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${htmlEscape(title)}</title></head><body><main><h1>${htmlEscape(title)}</h1>${body}</main></body></html>`
}

const INVALID = page(
  'This link is not valid',
  '<p>Turn off setup emails in Account, Notifications after signing in instead.</p>',
)

export function registerSetupUnsubscribeRoutes<E extends Env>(app: Hono<E>) {
  // The link in the email: a confirm page, so a link scanner that opens it unsubscribes nobody.
  app.get(SETUP_UNSUBSCRIBE_PATH, c => {
    const token = c.req.query('t')
    if (!readSetupUnsubscribeToken(token)) return c.html(INVALID, 400)
    return c.html(
      page(
        'Turn off setup emails?',
        `<p>You stop getting the emails that help set up ${htmlEscape(brandName())}. Call emails are not affected.</p><form method="post" action="${SETUP_UNSUBSCRIBE_PATH}?t=${htmlEscape(token ?? '')}"><button type="submit">Turn off setup emails</button></form>`,
      ),
    )
  })
  // The confirm page's button, and mail apps' one-click POST (body "List-Unsubscribe=One-Click", not read).
  app.post(SETUP_UNSUBSCRIBE_PATH, async c => {
    const who = readSetupUnsubscribeToken(c.req.query('t'))
    if (!who) return c.html(INVALID, 400)
    await unsubscribeFromSetupEmails(who.workspaceId, who.userId)
    // The same answer for a member who left: the token says nothing more than it did.
    return c.html(page('Setup emails are off', '<p>You won’t get any more of them. Call emails are not affected.</p>'))
  })
}
