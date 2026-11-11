// Knowledge (docs/architecture.md, Knowledge): the website import, reference documents and the
// look-up the voice agent does in them. Summary, services and FAQs are plain fields of the assistant
// (assistant.update); the questions the assistant could not answer are in knowledge-questions.ts.
import {
  type CallDocuments,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_TEXT_MAX,
  DOCUMENTS_INLINE_MAX,
  DOCUMENTS_MAX,
  documentKey,
  type documentTypes,
  type KnowledgeAddDocumentData,
  type KnowledgeImportData,
  type KnowledgeSearchData,
} from '@linedesk/actions'
import { calls, knowledge_chunks, knowledge_documents, type Tx } from '@linedesk/db'
import { and, asc, eq, sql } from 'drizzle-orm'
import { assistantIn } from './assistants.ts'
import { db } from './db.ts'
import { evaluationModel } from './evaluations.ts'
import { type Handler, type Preparer, Reject } from './handler-context.ts'
import { PdfRefused, pdfText } from './pdf-text.ts'
import { createFailureLimiter, createRateLimiter } from './rate-limit.ts'
import { activeRecordingStore, recordingStoreNamed } from './recording-store.ts'
import {
  IMPORT_SYSTEM,
  ImportRefused,
  importPrompt,
  type OwnerInput,
  parseProposal,
  readSite,
  type SitePage,
} from './site-import.ts'

const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

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
    throw new ImportRefused('The language model did not answer in time. Try again.')
  }
  return { ...proposal, pages: site.pages.map(p => ({ url: p.url, title: p.title })), website: site.website }
}

// --- Documents -----------------------------------------------------------------------------

type DocumentType = (typeof documentTypes)[number]
const EXTENSIONS: Record<DocumentType, 'pdf' | 'txt' | 'md'> = {
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
}

/**
 * The text of an uploaded file, at most DOCUMENT_TEXT_MAX characters. PDFs are read in a worker thread
 * with a time and memory limit (pdf-text.ts). Throws Reject for a file that is not what it says or has no text.
 */
export async function documentText(
  bytes: Uint8Array,
  mimeType: DocumentType,
): Promise<{ text: string; truncated: boolean }> {
  let text: string
  let truncated = false
  if (mimeType === 'application/pdf') {
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw new Reject('That file is not a PDF.')
    try {
      ;({ text, truncated } = await pdfText(new Uint8Array(bytes), DOCUMENT_TEXT_MAX))
    } catch (e) {
      throw new Reject(e instanceof PdfRefused ? e.message : 'That PDF could not be read.')
    }
  } else {
    text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    if (text.includes('\u0000')) throw new Reject('That file is not a text file.')
    truncated = text.length > DOCUMENT_TEXT_MAX
    text = text.slice(0, DOCUMENT_TEXT_MAX)
  }
  const clean = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (clean.length < 20)
    throw new Reject('There is no text in that file we can read. A scanned PDF needs text recognition first.')
  return { text: clean, truncated }
}

/** Uploads per workspace and hour (each may read a PDF in a worker for up to 20 s); per API process, like imports. */
export const DOCUMENTS_PER_HOUR = 20
const documentBudget = createRateLimiter({ max: DOCUMENTS_PER_HOUR, windowMs: 3600_000 })

const CHUNK_CHARS = 900

/** Passages of about CHUNK_CHARS, cut at paragraph and then sentence ends, for the search. */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = []
  let current = ''
  const pieces = text.split(/\n\n+/).flatMap(p => (p.length > size ? p.split(/(?<=[.!?])\s+/) : [p]))
  for (const piece of pieces) {
    for (let start = 0; start < piece.length; start += size) {
      const part = piece.slice(start, start + size)
      if (current && current.length + part.length + 2 > size) {
        chunks.push(current)
        current = ''
      }
      current = current ? `${current}\n\n${part}` : part
    }
  }
  if (current) chunks.push(current)
  return chunks
}

type AddInput = { assistantId: string; name: string; mimeType: DocumentType; data: string }
type Prepared = {
  id: string
  text: string
  truncated: boolean
  size: number
  store: { name: 'file' | 's3'; key: string } | null
}

/** Outside the transaction: reading a PDF and writing the original to the store take a while. */
export const knowledgePreparers: Record<string, Preparer> = {
  'knowledge.addDocument': async ({ actor, onRollback }, input: AddInput): Promise<Prepared> => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    await assistantIn(db, actor.workspaceId, input.assistantId)
    const bytes = Buffer.from(input.data, 'base64')
    if (bytes.byteLength > DOCUMENT_MAX_BYTES)
      throw new Reject(`The file is larger than ${DOCUMENT_MAX_BYTES / 1024 / 1024} MB.`)
    if (!documentBudget(actor.workspaceId))
      throw new Reject(`At most ${DOCUMENTS_PER_HOUR} documents an hour. Try again later.`)
    const { text, truncated } = await documentText(bytes, input.mimeType)
    const id = newId('kd')
    const active = await activeRecordingStore(db).catch(() => null)
    let store: Prepared['store'] = null
    if (active) {
      const key = documentKey(actor.workspaceId, id, EXTENSIONS[input.mimeType])
      try {
        await active.store.put(key, bytes, input.mimeType)
        store = { name: active.name, key }
        onRollback(async () => {
          await active.store.delete(key)
          return `deleted ${key}`
        })
      } catch (e) {
        // The text is what the assistant uses; without the original the document still works.
        console.warn(`knowledge document ${id}: original not stored (${e instanceof Error ? e.message : String(e)})`)
      }
    }
    return {
      id,
      text,
      truncated,
      size: bytes.byteLength,
      store,
    }
  },
}

/** The assistant's documents for a call: their text when short in all, else the look-up. */
export async function documentsForCall(tx: Tx, assistantId: string | null | undefined): Promise<CallDocuments | null> {
  if (!assistantId) return null
  const docs = await tx
    .select({ id: knowledge_documents.id, name: knowledge_documents.name, chars: knowledge_documents.chars })
    .from(knowledge_documents)
    .where(eq(knowledge_documents.assistant_id, assistantId))
    .orderBy(asc(knowledge_documents.created_at))
  if (!docs.length) return null
  const total = docs.reduce((sum, d) => sum + d.chars, 0)
  if (total > DOCUMENTS_INLINE_MAX) return { inline: null, lookUp: true }
  const chunks = await tx
    .select({ document: knowledge_chunks.document_id, text: knowledge_chunks.text })
    .from(knowledge_chunks)
    .where(eq(knowledge_chunks.assistant_id, assistantId))
    .orderBy(asc(knowledge_chunks.position))
  const inline = docs
    .map(
      d =>
        `From "${d.name}":\n${chunks
          .filter(c => c.document === d.id)
          .map(c => c.text)
          .join('\n\n')}`,
    )
    .join('\n\n')
  return { inline, lookUp: false }
}

/** Passages the look-up returns, and how much text in all. */
const SEARCH_RESULTS = 3
const SEARCH_CHARS = 2400

/**
 * Full-text search in Postgres over the assistant's chunks: any of the query's words (OR), ranked by
 * cover density. Local and free; good enough for "do you warranty water heaters" against a price sheet.
 */
export async function searchDocuments(
  tx: Tx,
  assistantId: string,
  query: string,
): Promise<KnowledgeSearchData['passages']> {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  if (!words.length) return []
  const terms = [...new Set(words)].slice(0, 12).join(' ')
  const tsquery = sql`replace(plainto_tsquery('english', ${terms})::text, '&', '|')::tsquery`
  const rows = await tx
    .select({ document: knowledge_documents.name, text: knowledge_chunks.text })
    .from(knowledge_chunks)
    .innerJoin(knowledge_documents, eq(knowledge_documents.id, knowledge_chunks.document_id))
    .where(and(eq(knowledge_chunks.assistant_id, assistantId), sql`${knowledge_chunks.search} @@ ${tsquery}`))
    .orderBy(sql`ts_rank_cd(${knowledge_chunks.search}, ${tsquery}) desc`)
    .limit(SEARCH_RESULTS)
  let left = SEARCH_CHARS
  return rows.flatMap(r => {
    if (left <= 0) return []
    const text = r.text.slice(0, left)
    left -= text.length
    return [{ document: r.document, text }]
  })
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

  'knowledge.addDocument': async ({ tx, actor, prepared }, input: AddInput) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const doc = prepared as Prepared
    const assistant = await assistantIn(tx, actor.workspaceId, input.assistantId)
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(knowledge_documents)
      .where(eq(knowledge_documents.assistant_id, assistant!.id))
    if (n >= DOCUMENTS_MAX) throw new Reject(`An assistant can have ${DOCUMENTS_MAX} documents. Remove one first.`)
    const [row] = await tx
      .insert(knowledge_documents)
      .values({
        id: doc.id,
        workspace_id: actor.workspaceId,
        assistant_id: assistant!.id,
        name: input.name,
        mime_type: input.mimeType,
        size_bytes: doc.size,
        chars: doc.text.length,
        store: doc.store?.name ?? null,
        storage_key: doc.store?.key ?? null,
        created_by: actor.actorId,
      })
      .returning()
    const chunks = chunkText(doc.text)
    if (chunks.length)
      await tx.insert(knowledge_chunks).values(
        chunks.map((text, position) => ({
          id: newId('kc'),
          workspace_id: actor.workspaceId!,
          document_id: doc.id,
          assistant_id: assistant!.id,
          position,
          text,
        })),
      )
    const data: KnowledgeAddDocumentData = { documentId: doc.id, chars: doc.text.length, truncated: doc.truncated }
    return { rows: { knowledge_documents: [row!] }, data }
  },

  'knowledge.removeDocument': async ({ tx, actor }, input: { documentId: string }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const [doc] = await tx
      .delete(knowledge_documents)
      .where(and(eq(knowledge_documents.id, input.documentId), eq(knowledge_documents.workspace_id, actor.workspaceId)))
      .returning()
    if (!doc) throw new Reject('document not found')
    if (doc.store && doc.storage_key) {
      // The text is gone with the row; the original is cleaned up best-effort (it is unreachable either way).
      const key = doc.storage_key
      void recordingStoreNamed(db, doc.store)
        .then(store => store.delete(key))
        .catch(e =>
          console.warn(
            `knowledge document ${doc.id}: original not deleted (${e instanceof Error ? e.message : String(e)})`,
          ),
        )
    }
    return { rows: {}, deleted: { knowledge_documents: [doc.id] } }
  },

  /** The agent's look-up: in the documents of the assistant that answers this call. */
  'knowledge.search': async ({ tx, actor }, input: { callId: string; query: string }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const [call] = await tx
      .select({ assistantId: calls.assistant_id })
      .from(calls)
      .where(and(eq(calls.id, input.callId), eq(calls.workspace_id, actor.workspaceId)))
    if (!call) throw new Reject('call not found')
    const passages = call.assistantId ? await searchDocuments(tx, call.assistantId, input.query) : []
    const data: KnowledgeSearchData = { passages }
    return { rows: {}, data }
  },
}
