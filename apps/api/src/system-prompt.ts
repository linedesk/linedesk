// System prompt (LIN-346; Server admin › System prompt): the instance admin's own wording for the fixed parts of the
// assistant's system prompt (packages/actions/src/system-prompt.ts). One row of `prompt_overrides` per edited part;
// `call.start` hands them to the voice agent, which uses an edit only while it fits the part's default.
import {
  overrideFits,
  PROMPT_TEXT_KEYS,
  PROMPT_TEXTS,
  type PromptOverrides,
  type PromptTextKey,
  type SystemPromptData,
} from '@linedesk/actions'
import { prompt_overrides, type Tx } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import type { Handler } from './handler-context.ts'

const isKey = (key: string): key is PromptTextKey => (PROMPT_TEXT_KEYS as readonly string[]).includes(key)

/** Every edited part for the admin page, in the order of PROMPT_TEXTS; rows of parts no longer in the code are left out. */
export async function systemPromptData(tx: Tx): Promise<SystemPromptData> {
  const rows = new Map((await tx.select().from(prompt_overrides)).map(row => [row.key, row]))
  const overrides = PROMPT_TEXT_KEYS.flatMap(key => {
    const row = rows.get(key)
    if (!row) return []
    return [
      {
        key,
        text: row.text,
        defaultChanged: row.default_text !== PROMPT_TEXTS[key].text,
        fits: overrideFits(key, row.text),
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      },
    ]
  })
  return { overrides }
}

/** The edited parts for a call, by key: the agent builds the prompt with them (and the defaults for the rest). */
export async function promptOverridesForCall(tx: Tx): Promise<PromptOverrides> {
  const rows = await tx.select({ key: prompt_overrides.key, text: prompt_overrides.text }).from(prompt_overrides)
  return Object.fromEntries(rows.filter(row => isKey(row.key)).map(row => [row.key, row.text]))
}

export const systemPromptHandlers: Record<string, Handler> = {
  'systemPrompt.get': async ({ tx }) => ({ rows: {}, data: await systemPromptData(tx) }),

  'systemPrompt.setPart': async ({ tx, actor, now }, input: { key: PromptTextKey; text: string }) => {
    const defaultText = PROMPT_TEXTS[input.key].text
    // The default text is no edit: the part goes back to the default, and follows it when it changes.
    if (input.text === defaultText) await tx.delete(prompt_overrides).where(eq(prompt_overrides.key, input.key))
    else {
      const values = { text: input.text, default_text: defaultText, updated_at: now, updated_by: actor.actorId }
      await tx
        .insert(prompt_overrides)
        .values({ key: input.key, ...values })
        .onConflictDoUpdate({ target: prompt_overrides.key, set: values })
    }
    return { rows: {}, data: await systemPromptData(tx) }
  },

  'systemPrompt.resetPart': async ({ tx }, input: { key: PromptTextKey }) => {
    await tx.delete(prompt_overrides).where(eq(prompt_overrides.key, input.key))
    return { rows: {}, data: await systemPromptData(tx) }
  },
}
