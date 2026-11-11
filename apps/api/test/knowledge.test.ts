// Knowledge: documents (text extraction, limits, inline vs look-up on a call, the agent's search),
// questions the assistant could not answer (stored from the evaluation, answered into FAQs) and the
// limits on services and FAQs.
import { DOCUMENTS_INLINE_MAX, FAQS_MAX, OPEN_QUESTIONS_MAX } from '@linedesk/actions'
import { assistants, knowledge_chunks, knowledge_questions } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { chunkText } from '../src/knowledge.ts'
import { addOpenQuestions, questionKey } from '../src/knowledge-questions.ts'
import {
  act,
  addMember,
  agent,
  createWorkspace,
  getAssistant,
  randomNumber,
  type User,
  type Workspace,
} from './helpers.ts'

const base64 = (text: string) => Buffer.from(text).toString('base64')
const addText = (who: User, assistantId: string, name: string, text: string) =>
  act(who, 'knowledge.addDocument', { assistantId, name, mimeType: 'text/plain', data: base64(text) })

let ws: Workspace
let member: User
beforeAll(async () => {
  ws = await createWorkspace('Knowledge Plumbing')
  member = await addMember(ws.id, 'member')
})

describe('documents', () => {
  test('a short text document goes into every call; its text is kept in chunks', async () => {
    const own = await createWorkspace('Short Docs Plumbing')
    const res = await addText(
      own.owner,
      own.assistant.id,
      'warranty.txt',
      'All water heaters carry a 6 year tank warranty.',
    )
    expect(res.status).toBe(200)
    const { documentId } = res.body.data
    expect(await db.select().from(knowledge_chunks).where(eq(knowledge_chunks.document_id, documentId))).toHaveLength(1)
    const started = await act(agent(), 'call.start', { from: randomNumber(), to: own.number })
    expect(started.body.data.documents).toEqual({
      inline: expect.stringContaining('6 year tank warranty'),
      lookUp: false,
    })
  })

  test('long documents are looked up instead, and the search finds the passage in this assistant only', async () => {
    const own = await createWorkspace('Long Docs Plumbing')
    const filler = 'Our technicians are licensed and insured. '.repeat(Math.ceil(DOCUMENTS_INLINE_MAX / 40))
    await addText(
      own.owner,
      own.assistant.id,
      'handbook.txt',
      `${filler}\n\nTankless water heaters are serviced every year for $149.`,
    )
    const { callId } = (await act(agent(), 'call.start', { from: randomNumber(), to: own.number })).body.data
    const call = await act(agent(), 'call.start', { from: randomNumber(), to: own.number })
    expect(call.body.data.documents).toEqual({ inline: null, lookUp: true })
    const found = await act(agent(own.id), 'knowledge.search', { callId, query: 'tankless heater service' })
    expect(found.body.data.passages[0].text).toContain('Tankless water heaters are serviced every year')
    // Another workspace's agent call cannot read them.
    const other = await act(agent(ws.id), 'knowledge.search', { callId, query: 'tankless' })
    expect(other.status).toBe(409)
  })

  test('a file that is not what it says, or has no text, is refused; members cannot add', async () => {
    const pdf = await act(ws.owner, 'knowledge.addDocument', {
      assistantId: ws.assistant.id,
      name: 'x.pdf',
      mimeType: 'application/pdf',
      data: base64('not a pdf at all'),
    })
    expect(pdf).toMatchObject({ status: 409, body: { error: 'That file is not a PDF.' } })
    expect((await addText(ws.owner, ws.assistant.id, 'empty.txt', '   ')).status).toBe(409)
    expect((await addText(member, ws.assistant.id, 'a.txt', 'Some text about drains and pipes.')).status).toBe(403)
  })

  test('removing a document deletes its text', async () => {
    const own = await createWorkspace('Remove Docs Plumbing')
    const { documentId } = (await addText(own.owner, own.assistant.id, 'a.txt', 'Drain cleaning is $199 on weekdays.'))
      .body.data
    expect((await act(ws.owner, 'knowledge.removeDocument', { documentId })).status).toBe(409) // not their workspace
    const removed = await act(own.owner, 'knowledge.removeDocument', { documentId })
    expect(removed.body.deleted).toEqual({ knowledge_documents: [documentId] })
    expect(await db.select().from(knowledge_chunks).where(eq(knowledge_chunks.document_id, documentId))).toEqual([])
  })

  test('text is cut into passages at paragraph ends', () => {
    const chunks = chunkText(`${'a'.repeat(500)}\n\n${'b'.repeat(500)}\n\n${'c'.repeat(100)}`, 900)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe('a'.repeat(500))
    expect(chunks.every(c => c.length <= 900)).toBe(true)
  })
})

describe('questions the assistant could not answer', () => {
  test('stored once per question, not when already an FAQ, and at most the open limit', async () => {
    const own = await createWorkspace('Questions Plumbing')
    await db
      .update(assistants)
      .set({ business_profile: { faqs: [{ q: 'Do you work weekends?', a: 'Saturdays.' }] } })
      .where(eq(assistants.id, own.assistant.id))
    const where = { workspaceId: own.id, assistantId: own.assistant.id, callId: own.call.id }
    const added = await addOpenQuestions(db, where, [
      'Do you service tankless heaters?',
      'do you work weekends',
      'Do you service tankless heaters',
    ])
    expect(added.map(q => q.question)).toEqual(['Do you service tankless heaters?'])
    const many = Array.from({ length: OPEN_QUESTIONS_MAX + 5 }, (_, i) => `Question number ${i}?`)
    await addOpenQuestions(db, where, many)
    const open = await db
      .select()
      .from(knowledge_questions)
      .where(eq(knowledge_questions.assistant_id, own.assistant.id))
    expect(open).toHaveLength(OPEN_QUESTIONS_MAX)
    expect(questionKey('Do you work Weekends?!')).toBe(questionKey('do you work weekends'))
  })

  test('answering one adds it to the FAQs and closes it; members cannot; dismiss closes without an FAQ', async () => {
    const own = await createWorkspace('Answer Plumbing')
    const where = { workspaceId: own.id, assistantId: own.assistant.id, callId: own.call.id }
    const [first, second] = await addOpenQuestions(db, where, ['Do you install water softeners?', 'Is parking free?'])
    const helper = await addMember(own.id, 'member')
    expect((await act(helper, 'knowledgeQuestion.answer', { questionId: first!.id, answer: 'Yes.' })).status).toBe(403)
    const res = await act(own.owner, 'knowledgeQuestion.answer', {
      questionId: first!.id,
      answer: 'Yes, from $1,200 installed.',
    })
    expect(res.status).toBe(200)
    expect((await getAssistant(own.assistant.id))!.business_profile.faqs).toEqual([
      { q: 'Do you install water softeners?', a: 'Yes, from $1,200 installed.' },
    ])
    expect(res.body.rows.knowledge_questions[0]).toMatchObject({ status: 'answered' })
    expect((await act(own.owner, 'knowledgeQuestion.answer', { questionId: first!.id, answer: 'Again.' })).status).toBe(
      409,
    )
    await act(own.owner, 'knowledgeQuestion.dismiss', { questionId: second!.id })
    const [dismissed] = await db.select().from(knowledge_questions).where(eq(knowledge_questions.id, second!.id))
    expect(dismissed!.status).toBe('dismissed')
    expect((await getAssistant(own.assistant.id))!.business_profile.faqs).toHaveLength(1)
  })

  test(`no answer once the assistant has ${FAQS_MAX} FAQs`, async () => {
    const own = await createWorkspace('Full FAQ Plumbing')
    const faqs = Array.from({ length: FAQS_MAX }, (_, i) => ({ q: `Q${i}?`, a: 'A.' }))
    await db.update(assistants).set({ business_profile: { faqs } }).where(eq(assistants.id, own.assistant.id))
    const [q] = await addOpenQuestions(
      db,
      { workspaceId: own.id, assistantId: own.assistant.id, callId: own.call.id },
      ['Something new?'],
    )
    expect(await act(own.owner, 'knowledgeQuestion.answer', { questionId: q!.id, answer: 'Yes.' })).toMatchObject({
      status: 409,
    })
  })
})

describe('services and FAQs', () => {
  test('assistant.update takes services with prices and refuses more than the limits', async () => {
    const service_list = [
      { name: 'Drain cleaning', description: 'Sinks and tubs', price: '$149' },
      { name: 'Water heater install', description: '', price: '' },
    ]
    const ok = await act(ws.owner, 'assistant.update', {
      assistantId: ws.assistant.id,
      business_profile: { instructions: 'We fix pipes.', service_list },
    })
    expect(ok.status).toBe(200)
    expect((await getAssistant(ws.assistant.id))!.business_profile.service_list).toEqual(service_list)
    const faqs = Array.from({ length: FAQS_MAX + 1 }, (_, i) => ({ q: `Q${i}?`, a: 'A.' }))
    expect(
      (await act(ws.owner, 'assistant.update', { assistantId: ws.assistant.id, business_profile: { faqs } })).status,
    ).toBe(422)
  })
})
