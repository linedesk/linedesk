// The GitHub star prompt: after some real use, a member is asked once to star Linedesk's repository.
// Members who signed in with GitHub star it in one click: GitHub asks them once to allow starring,
// and Linedesk stars on the way back, then gives the permission up again. Everyone else gets the
// repository page. Any answer is final (apps/api/src/star-prompt.ts).
import { z } from 'zod'
import { defineAction } from './define.ts'

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
