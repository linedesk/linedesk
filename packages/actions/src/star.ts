// The GitHub star prompt: two minutes into each session, a member is asked to star Linedesk's repository
// until they answer.
// Members who signed in with GitHub star it in one click: GitHub asks them once to allow starring,
// and Linedesk stars on the way back, then gives the permission up again. Everyone else gets the
// repository page. Any answer is final (apps/api/src/star-prompt.ts).
import { z } from 'zod'
import { defineAction } from './define.ts'

/** The repository every install asks members to star: the prompt, the sidebar and the end of onboarding. */
export const STAR_REPO = 'linedesk/linedesk'
export const STAR_REPO_URL = `https://github.com/${STAR_REPO}`

/** "1.2k" from 1234, "987" from 987: how the star count reads next to Star on GitHub. */
export function formatStarCount(stars: number): string {
  if (stars < 1000) return String(stars)
  const thousands = stars / 1000
  return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, '') : Math.round(thousands)}k`
}

/** The scope GitHub requires for starring with an OAuth app token. Asked for only when the member clicks Star. */
export const STAR_SCOPE = 'public_repo'

/** `/v1/me` while the prompt is due. `github`: the member signed in with GitHub, so Star works in one click. */
export type StarPrompt = { repo: string; github: boolean }

export const starPromptAnswer = defineAction({
  name: 'starPrompt.answer',
  description: 'Answer the GitHub star prompt: opened the repository page, or dismissed it. It is not shown again.',
  input: z.object({ answer: z.enum(['opened', 'dismissed']) }),
  permission: 'call:read',
})
