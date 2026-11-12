// Questions callers asked that the assistant could not answer (docs/architecture.md, Knowledge). The
// call evaluation names them; they wait in Settings › Assistant › Business info until the owner answers one
// (question and answer are added to the About text) or dismisses it.
import { answeredQuestionLine, INSTRUCTIONS_MAX, type knowledgeQuestionAnswer, OPEN_QUESTIONS_MAX } from '@linedesk/actions'
import { assistants, knowledge_questions, type Tx } from '@linedesk/db'
import type { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import { type Handler, Reject } from './handler-context.ts'

const newId = () => `kq_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`

/** Same question, whatever the case, spacing or final punctuation. */
export const questionKey = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/**
 * Stores new open questions of a call. Skipped: a question already asked on this assistant (open,
 * answered or dismissed) and any beyond OPEN_QUESTIONS_MAX open ones.
 */
export async function addOpenQuestions(
  tx: Tx,
  where: { workspaceId: string; assistantId: string; callId: string },
  questions: string[],
) {
  if (!questions.length) return []
  const known = new Set<string>()
  const existing = await tx
    .select({ question: knowledge_questions.question, status: knowledge_questions.status })
    .from(knowledge_questions)
    .where(eq(knowledge_questions.assistant_id, where.assistantId))
  for (const row of existing) known.add(questionKey(row.question))
  let open = existing.filter(r => r.status === 'open').length
  const added = []
  for (const question of questions) {
    const key = questionKey(question)
    if (!key || known.has(key) || open >= OPEN_QUESTIONS_MAX) continue
    known.add(key)
    open++
    const [row] = await tx
      .insert(knowledge_questions)
      .values({
        id: newId(),
        workspace_id: where.workspaceId,
        assistant_id: where.assistantId,
        call_id: where.callId,
        question: question.trim(),
      })
      .returning()
    added.push(row!)
  }
  return added
}

type AnswerInput = z.infer<typeof knowledgeQuestionAnswer.input>

export const knowledgeQuestionHandlers: Record<string, Handler> = {
  /** Question and answer are added to the assistant's About text, in the same transaction as the question is closed. */
  'knowledgeQuestion.answer': async ({ tx, actor, now }, input: AnswerInput) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const [question] = await tx
      .select()
      .from(knowledge_questions)
      .where(and(eq(knowledge_questions.id, input.questionId), eq(knowledge_questions.workspace_id, actor.workspaceId)))
    if (!question) throw new Reject('question not found')
    if (question.status !== 'open') throw new Reject('this question was already handled')
    // Locks the assistant row, so two answers at once both land in the text.
    const [assistant] = await tx.select().from(assistants).where(eq(assistants.id, question.assistant_id)).for('update')
    if (!assistant) throw new Reject('assistant not found')
    const about = assistant.business_profile.instructions?.trim() ?? ''
    const instructions = [about, answeredQuestionLine(input.question ?? question.question, input.answer)].filter(Boolean).join('\n')
    if (instructions.length > INSTRUCTIONS_MAX) throw new Reject('About the business is full. Shorten it first.')
    const [updated] = await tx
      .update(assistants)
      .set({ business_profile: { ...assistant.business_profile, instructions } })
      .where(eq(assistants.id, assistant.id))
      .returning()
    const [closed] = await tx
      .update(knowledge_questions)
      .set({ status: 'answered', resolved_at: now })
      .where(eq(knowledge_questions.id, question.id))
      .returning()
    return { rows: { assistants: [updated!], knowledge_questions: [closed!] } }
  },

  'knowledgeQuestion.dismiss': async ({ tx, actor, now }, input: { questionId: string }) => {
    if (!actor.workspaceId) throw new Reject('no workspace')
    const rows = await tx
      .update(knowledge_questions)
      .set({ status: 'dismissed', resolved_at: now })
      .where(
        and(
          eq(knowledge_questions.id, input.questionId),
          eq(knowledge_questions.workspace_id, actor.workspaceId),
          eq(knowledge_questions.status, 'open'),
        ),
      )
      .returning()
    return { rows: { knowledge_questions: rows } }
  },
}
