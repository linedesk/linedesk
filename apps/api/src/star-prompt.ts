// The GitHub star prompt (packages/actions/src/star.ts): when it is due, and starring in one click.
// It is due once a member has used Linedesk for a while: their account is a few days old and their
// workspace has handled real calls. Never while an instance admin is signed in as them, never during
// onboarding, never again once they answered.
//
// One click: the web app asks GitHub for STAR_SCOPE (public_repo) through Better Auth's account link,
// only when the member clicks Star. public_repo can write to all of the member's public repositories,
// so the token never stays: when Better Auth stores a GitHub token with it (starOnGrantHooks), this
// stars the repository at once, revokes the app's grant at GitHub (so the scope does not come back with
// the next GitHub sign-in) and clears the token and the scope from the account row.
import { STAR_SCOPE, type StarPrompt } from '@linedesk/actions'
import { account, calls, star_prompts, type Tx, user, workspace_settings } from '@linedesk/db'
import { decryptOAuthToken } from 'better-auth/oauth2'
import { and, count, eq, isNull } from 'drizzle-orm'
import { authConfig } from './auth-methods.ts'
import type { Actor } from './context.ts'
import { db } from './db.ts'
import { Forbidden, type Handler } from './handler-context.ts'
import { createRateLimiter } from './rate-limit.ts'

/** Days since the member's account was made before the prompt can show. */
export const STAR_MIN_ACCOUNT_DAYS = 3
/** Real calls (by phone, finished) the workspace has handled before the prompt can show. */
export const STAR_MIN_CALLS = 10

const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/

/** STAR_PROMPT_REPO: the repository to ask for a star (owner/name). Unset, empty or `off`: no prompt. */
export function starRepo(env: Record<string, string | undefined> = process.env): string | null {
  const value = (env.STAR_PROMPT_REPO ?? '').trim()
  if (!value || value.toLowerCase() === 'off') return null
  if (!REPO_PATTERN.test(value)) throw new Error(`STAR_PROMPT_REPO must look like owner/name or be off: ${value}`)
  return value
}

/** Whether GitHub granted starring: `public_repo` or the wider `repo` (scopes are comma or space separated). */
export const grantsStarring = (scope: string | null | undefined) =>
  (scope ?? '').split(/[\s,]+/).some(s => s === STAR_SCOPE || s === 'repo')

/** Only a member's own session answers for them: not an API key, the voice agent or an admin signed in as them. */
const answersForThemselves = (actor: Actor) =>
  !actor.impersonation && !actor.apiKeyId && actor.role !== 'agent' && Boolean(actor.sessionId)

async function hasGitHubSignIn(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'github')))
  return Boolean(row)
}

const answered = async (userId: string) =>
  (await db.select().from(star_prompts).where(eq(star_prompts.user_id, userId))).length > 0

async function workspaceInUse(workspaceId: string): Promise<boolean> {
  const [settings] = await db
    .select({ step: workspace_settings.onboarding_step })
    .from(workspace_settings)
    .where(eq(workspace_settings.workspace_id, workspaceId))
  // The same rule as onboardingFor: no step, done or skipped means onboarding is over.
  if (settings?.step && settings.step !== 'done' && settings.step !== 'skipped') return false
  const [handled] = await db
    .select({ n: count() })
    .from(calls)
    .where(
      and(
        eq(calls.workspace_id, workspaceId),
        eq(calls.source, 'phone'),
        eq(calls.status, 'completed'),
        isNull(calls.deleted_at),
      ),
    )
  return (handled?.n ?? 0) >= STAR_MIN_CALLS
}

/** For `/v1/me`: the prompt while it is due for this member, else null. */
export async function starPromptFor(actor: Actor, now = new Date(), env = process.env): Promise<StarPrompt | null> {
  const repo = starRepo(env)
  if (!repo || !actor.workspaceId || !answersForThemselves(actor)) return null
  if (await answered(actor.actorId)) return null
  const [member] = await db.select({ createdAt: user.createdAt }).from(user).where(eq(user.id, actor.actorId))
  if (!member || now.getTime() - member.createdAt.getTime() < STAR_MIN_ACCOUNT_DAYS * 86_400_000) return null
  if (!(await workspaceInUse(actor.workspaceId))) return null
  return { repo, github: await hasGitHubSignIn(actor.actorId) }
}

/** PUT /user/starred/{owner}/{repo}: 204 when starred (also when it already was). */
export async function starOnGitHub(
  repo: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const res = await fetchImpl(`https://api.github.com/user/starred/${repo}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'linedesk',
      'content-length': '0',
    },
    redirect: 'error',
  }).catch(() => null)
  return res?.status === 204
}

/**
 * DELETE /applications/{client_id}/grant: GitHub forgets this app's authorization of the member,
 * with every token and scope of it. Their next GitHub sign-in asks again, for the sign-in scopes only.
 */
export async function revokeGitHubGrant(
  accessToken: string,
  keys: { clientId: string; clientSecret: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const basic = Buffer.from(`${keys.clientId}:${keys.clientSecret}`).toString('base64')
  const res = await fetchImpl(`https://api.github.com/applications/${keys.clientId}/grant`, {
    method: 'DELETE',
    headers: {
      authorization: `Basic ${basic}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'linedesk',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ access_token: accessToken }),
    redirect: 'error',
  }).catch(() => null)
  return res?.status === 204
}

/** At most this many stars a member's grants trigger per hour (each needs a GitHub consent round trip anyway). */
const allowStar = createRateLimiter({ max: 3, windowMs: 60 * 60_000 })

/** The scopes without the ones that can write to repositories. */
const withoutWriteScopes = (scope: string | null) =>
  (scope ?? '')
    .split(/[\s,]+/)
    .filter(s => s && s !== STAR_SCOPE && s !== 'repo')
    .join(',')

type GitHubAccountRow = {
  id: string
  userId: string
  providerId: string
  accessToken?: string | null
  scope?: string | null
}
// biome-ignore lint/suspicious/noExplicitAny: Better Auth's endpoint context; only its AuthContext is used
type HookCtx = { context?: any } | null | undefined

/**
 * Runs after Better Auth stored a GitHub account. When the token can write repositories: star the
 * repository if the member's prompt is still open (and the rate limit allows), then revoke the grant
 * at GitHub and clear the token and the write scopes here, whatever happened before.
 */
export async function starOnGrant(row: GitHubAccountRow, ctx: HookCtx, env = process.env): Promise<void> {
  if (row.providerId !== 'github' || !grantsStarring(row.scope)) return
  const token = row.accessToken && ctx?.context ? await decryptOAuthToken(row.accessToken, ctx.context) : null
  try {
    const repo = starRepo(env)
    if (token && repo && !(await answered(row.userId)) && allowStar(row.userId) && (await starOnGitHub(repo, token)))
      await recordAnswer(db, row.userId, 'starred', new Date().toISOString())
  } finally {
    if (token && authConfig.github) await revokeGitHubGrant(token, authConfig.github)
    await db
      .update(account)
      .set({ accessToken: null, refreshToken: null, scope: withoutWriteScopes(row.scope ?? null) })
      .where(eq(account.id, row.id))
  }
}

/** For `mergeDatabaseHooks` in auth.ts. */
export const starOnGrantHooks = {
  account: {
    create: { after: (row: GitHubAccountRow, ctx: HookCtx) => starOnGrant(row, ctx) },
    update: { after: (row: GitHubAccountRow, ctx: HookCtx) => starOnGrant(row, ctx) },
  },
}

const notForOthers = (actor: Actor) => {
  if (!answersForThemselves(actor)) throw new Forbidden('Only you can answer this, in your own session.')
}

async function recordAnswer(
  tx: Tx | typeof db,
  userId: string,
  answer: 'starred' | 'opened' | 'dismissed',
  now: string,
) {
  await tx
    .insert(star_prompts)
    .values({ user_id: userId, answer, answered_at: now })
    .onConflictDoNothing({ target: star_prompts.user_id })
}

export const starHandlers: Record<string, Handler> = {
  'starPrompt.answer': async ({ tx, actor, now }, input: { answer: 'opened' | 'dismissed' }) => {
    notForOthers(actor)
    await recordAnswer(tx, actor.actorId, input.answer, now)
    return { rows: {} }
  },
}
