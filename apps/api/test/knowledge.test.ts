// Knowledge: questions the assistant could not answer (stored from the evaluation, answered into the About
// text), and services, FAQs and documents no longer being offered.
import { OPEN_QUESTIONS_MAX } from '@linedesk/actions'
import { knowledge_questions } from '@linedesk/db'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { db } from '../src/db.ts'
import { addOpenQuestions, questionKey } from '../src/knowledge-questions.ts'
import { act, addMember, createWorkspace, getAssistant, type Workspace } from './helpers.ts'

let ws: Workspace
beforeAll(async () => {
  ws = await createWorkspace('Knowledge Plumbing')
})

describe('questions the assistant could not answer', () => {
  test('stored once per question, and at most the open limit', async () => {
    const own = await createWorkspace('Questions Plumbing')
    const where = { workspaceId: own.id, assistantId: own.assistant.id, callId: own.call.id }
    const added = await addOpenQuestions(db, where, ['Do you service tankless heaters?', 'Do you service tankless heaters'])
    expect(added.map(q => q.question)).toEqual(['Do you service tankless heaters?'])
    const many = Array.from({ length: OPEN_QUESTIONS_MAX + 5 }, (_, i) => `Question number ${i}?`)
    await addOpenQuestions(db, where, many)
    const open = await db.select().from(knowledge_questions).where(eq(knowledge_questions.assistant_id, own.assistant.id))
    expect(open).toHaveLength(OPEN_QUESTIONS_MAX)
    expect(questionKey('Do you work Weekends?!')).toBe(questionKey('do you work weekends'))
  })

  test('answering one adds it to the About text and closes it; members cannot; dismiss closes without an answer', async () => {
    const own = await createWorkspace('Answer Plumbing')
    await act(own.owner, 'assistant.update', { assistantId: own.assistant.id, business_profile: { instructions: 'We fix pipes.' } })
    const where = { workspaceId: own.id, assistantId: own.assistant.id, callId: own.call.id }
    const [first, second] = await addOpenQuestions(db, where, ['Do you install water softeners?', 'Is parking free?'])
    const helper = await addMember(own.id, 'member')
    expect((await act(helper, 'knowledgeQuestion.answer', { questionId: first!.id, answer: 'Yes.' })).status).toBe(403)
    const res = await act(own.owner, 'knowledgeQuestion.answer', { questionId: first!.id, answer: 'Yes, from $1,200 installed.' })
    expect(res.status).toBe(200)
    expect((await getAssistant(own.assistant.id))!.business_profile.instructions).toBe(
      'We fix pipes.\nIf a caller asks "Do you install water softeners?": Yes, from $1,200 installed.',
    )
    expect(res.body.rows.knowledge_questions[0]).toMatchObject({ status: 'answered' })
    expect((await act(own.owner, 'knowledgeQuestion.answer', { questionId: first!.id, answer: 'Again.' })).status).toBe(409)
    await act(own.owner, 'knowledgeQuestion.dismiss', { questionId: second!.id })
    const [dismissed] = await db.select().from(knowledge_questions).where(eq(knowledge_questions.id, second!.id))
    expect(dismissed!.status).toBe('dismissed')
    expect((await getAssistant(own.assistant.id))!.business_profile.instructions).not.toContain('parking')
  })
})

describe('services, FAQs and documents are no longer offered', () => {
  test('assistant.update keeps the About text and drops services and FAQs; the document actions are gone', async () => {
    const ok = await act(ws.owner, 'assistant.update', {
      assistantId: ws.assistant.id,
      business_profile: { instructions: 'We fix pipes.', service_list: [{ name: 'Drains', description: '', price: '$149' }], faqs: [{ q: 'Q?', a: 'A.' }] },
    })
    expect(ok.status).toBe(200)
    const profile = (await getAssistant(ws.assistant.id))!.business_profile
    expect(profile.instructions).toBe('We fix pipes.')
    expect(profile.service_list).toBeUndefined()
    expect(profile.faqs).toBeUndefined()
    for (const name of ['knowledge.addDocument', 'knowledge.removeDocument', 'knowledge.search'])
      expect((await act(ws.owner, name, {})).status, name).toBe(404)
  })
})
