// Knowledge (docs/architecture.md, Knowledge): "Write with help", which drafts the assistant's About text from
// the owner's words and the business's website. The About text is a field of the assistant (assistant.update);
// the questions the assistant could not answer are in knowledge-questions.ts.
import { type KnowledgeImportData, providerFailureReasonLabels } from '@linedesk/actions'
import { assistantIn } from './assistants.ts'
import { db } from './db.ts'
import { ChatRequestError, evaluationModel } from './evaluations.ts'
import { type Handler, Reject } from './handler-context.ts'
import { reasonOf } from './provider-errors.ts'
import { createFailureLimiter } from './rate-limit.ts'
import {
  IMPORT_SYSTEM,
  ImportRefused,
  importPrompt,
  type OwnerInput,
  parseProposal,
  readSite,
  type SitePage,
} from './site-import.ts'

// --- Website import ------------------------------------------------------------------------

/**
 * Imports per workspace and hour: each reads up to six pages and makes one long model request. Counted
 * in memory per API process, so with several API containers the real limit is this times their number.
 */
export const IMPORTS_PER_HOUR = 10
const importBudget = createFailureLimiter({ max: IMPORTS_PER_HOUR, windowMs: 3600_000 })

type ImportInput = { assistantId: string; url?: string } & OwnerInput

async function importProposal(input: ImportInput): Promise<KnowledgeImportData> {
  const site = input.url ? await readSite(input.url) : { website: null, pages: [] as SitePage[] }
  if (input.url && !site.pages.some(p => p.text.trim()))
    throw new ImportRefused('The website has no text we could read. Describe the business instead.')
  const model = await evaluationModel(db, fetch, { maxTokens: 3000, timeoutMs: 60_000 })
  if (!model)
    throw new ImportRefused('Writing with help needs a language model. An admin adds one under Admin › Providers.')
  let proposal: ReturnType<typeof parseProposal>
  try {
    proposal = parseProposal(await model.complete(IMPORT_SYSTEM, importPrompt(site.pages, input)))
  } catch (e) {
    console.warn(`knowledge import: ${e instanceof Error ? e.message : String(e)}`)
    // A provider failure (quota, key) is recorded for the admins (evaluations.ts); the member hears it is not a timeout.
    if (e instanceof ChatRequestError && e.status >= 300)
      throw new ImportRefused(
        `The language model is not working right now (${providerFailureReasonLabels[reasonOf(e.status, e.body)].toLowerCase()}). An admin can see it under Admin › Providers.`,
      )
    throw new ImportRefused('The language model did not answer in time. Try again.')
  }
  return { ...proposal, pages: site.pages.map(p => ({ url: p.url, title: p.title })), website: site.website }
}

export const knowledgeHandlers: Record<string, Handler> = {
  /** Read-only: reads the site and asks the model outside any transaction; nothing is saved. */
  'knowledge.import': async ({ actor }, input: ImportInput) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    await assistantIn(db, actor.workspaceId, input.assistantId)
    if (importBudget.blocked(actor.workspaceId))
      throw new Reject(`At most ${IMPORTS_PER_HOUR} drafts an hour. Try again later.`)
    importBudget.fail(actor.workspaceId)
    try {
      return { rows: {}, data: await importProposal(input) }
    } catch (e) {
      if (e instanceof ImportRefused) throw new Reject(e.message)
      throw e
    }
  },
}
