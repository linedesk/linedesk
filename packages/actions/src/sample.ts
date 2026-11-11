import { z } from 'zod'
import { defineAction } from './define.ts'

/**
 * How a new workspace is introduced, per install (`FIRST_USE`): a short product tour, sample calls to
 * try the inbox with, both, or nothing. Two variants to compare; the server tells the web app in /v1/me.
 */
export const firstUseVariants = ['tour', 'sample', 'both', 'off'] as const
export type FirstUse = (typeof firstUseVariants)[number]

export const offersTour = (v: FirstUse) => v === 'tour' || v === 'both'
export const offersSampleCalls = (v: FirstUse) => v === 'sample' || v === 'both'

/** Sample contacts have ids with this prefix, so removing the samples finds them without a column of their own. */
export const SAMPLE_ID_PREFIX = 'smp_'

export const sampleAdd = defineAction({
  name: 'sample.add',
  description:
    'Fill the workspace with a few sample calls (marked as samples, with callers and transcripts) to try the inbox. Does nothing when samples are already there.',
  input: z.object({}),
  permission: 'settings:write',
})

export const sampleRemove = defineAction({
  name: 'sample.remove',
  description: 'Remove every sample call of the workspace, with their transcripts and the sample callers.',
  input: z.object({}),
  permission: 'settings:write',
})
