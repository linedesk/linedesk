// System prompt (LIN-346; Server admin › System prompt): the instance admin's own wording for the fixed parts of the
// assistant's system prompt, for every workspace of the install. The parts, their keys and defaults are PROMPT_TEXTS
// (prompt-texts.ts); an edited part is a row of `prompt_overrides`, read by `call.start` and used by the voice agent
// when it builds the prompt. Variables ({name}, {hours}) stay: an edit must keep the same ones in the same order.
import { z } from 'zod'
import { defineAction } from './define.ts'
import { overrideFits, PROMPT_OVERRIDE_MAX, PROMPT_TEXT_KEYS, type PromptTextKey } from './prompt-texts.ts'

/**
 * The admin's text as it is stored: Windows line ends made plain, control characters other than line breaks and tabs
 * taken out, no blank space at the ends. Not fenced: these are the admin's instructions, not caller data.
 */
export const cleanPromptText = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: taking control characters out is the point
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim()

const partKey = z.enum(PROMPT_TEXT_KEYS as unknown as [PromptTextKey, ...PromptTextKey[]])

/** One edited part as the admin page shows it. */
export type SystemPromptOverride = {
  key: PromptTextKey
  text: string
  /** The default of this part changed in the code since the edit was saved. */
  defaultChanged: boolean
  /** The edit still has the default's variables: false after a release changed them, and then the default is used. */
  fits: boolean
  updatedAt: string
  updatedBy: string | null
}
/** `data` of systemPrompt.get, .setPart and .resetPart: every edited part, in the order of PROMPT_TEXTS. */
export type SystemPromptData = { overrides: SystemPromptOverride[] }

export const systemPromptGet = defineAction({
  name: 'systemPrompt.get',
  description:
    "The parts of the assistant's system prompt that an instance admin edited (Server admin › System prompt), for every workspace of this install: per part its key, the text, whether the default changed since the edit and whether the edit still fits. Parts that are not listed use the default.",
  input: z.object({}),
  permission: 'instance:admin',
  readOnly: true,
})

export const systemPromptSetPart = defineAction({
  name: 'systemPrompt.setPart',
  description:
    "Change the text of one part of the assistant's system prompt for every workspace of this install. The text must keep the part's variables ({name}, {hours}) in the same order. The default text resets the part.",
  input: z
    .object({
      key: partKey,
      text: z.string().max(PROMPT_OVERRIDE_MAX).transform(cleanPromptText).pipe(z.string().min(1)),
    })
    .refine(i => overrideFits(i.key, i.text), {
      message: 'keep the variables of the default text, in the same order',
      path: ['text'],
    }),
  permission: 'instance:admin',
})

export const systemPromptResetPart = defineAction({
  name: 'systemPrompt.resetPart',
  description:
    "Put one part of the assistant's system prompt back to its default text, for every workspace of this install.",
  input: z.object({ key: partKey }),
  permission: 'instance:admin',
})
