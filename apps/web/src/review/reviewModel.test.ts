import { type QuestionGroup, questionKey } from '@linedesk/actions'
import type { KnowledgeQuestion } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import { askedLabel, needsALook, openGroupCount, openGroups, otherIds, reviewTitle, scoreWords } from './reviewModel.ts'

describe('How the assistant did (staff only)', () => {
  it('names the evaluation after the assistant', () => {
    expect(reviewTitle('Maya')).toBe('How Maya did')
    expect(reviewTitle('  ')).toBe('How the assistant did')
  })

  it('says the score in words, never "Needs review"', () => {
    expect([5, 4, 3, 2, 1].map(scoreWords)).toEqual([
      'Handled well',
      'Mostly fine',
      'Missed something',
      'Went wrong',
      'Went wrong',
    ])
    expect([5, 4, 3, 2, 1].map(needsALook)).toEqual([false, false, true, true, true])
  })
})

describe("Questions the assistant couldn't answer", () => {
  const group = (questionId: string, asked = 1, questionIds = [questionId]): QuestionGroup => ({
    questionId,
    questionIds,
    assistantId: 'as_1',
    question: questionId,
    asked,
    callIds: [],
    lastAskedAt: '2026-11-14T10:00:00Z',
  })
  const row = (id: string, status: KnowledgeQuestion['status'], question = id, assistant_id = 'as_1') =>
    ({ id, status, question, assistant_id }) as KnowledgeQuestion

  it('says how often a question was asked', () => {
    expect(askedLabel(1)).toBe('Asked once')
    expect(askedLabel(3)).toBe('Asked 3 times')
  })

  it('a group answered or dismissed on this device leaves at once; one not synced yet stays', () => {
    const groups = [group('q1', 3), group('q2'), group('q3')]
    expect(openGroups(groups, [row('q1', 'answered'), row('q2', 'open'), row('q9', 'dismissed')])).toEqual([
      group('q2'),
      group('q3'),
    ])
  })

  it('a group stays while one of its questions is open; Add answer and Dismiss close the rest with it', () => {
    const fees = group('q1', 2, ['q1', 'q4'])
    expect(openGroups([fees], [row('q1', 'answered'), row('q4', 'open')])).toEqual([fees])
    expect(openGroups([fees], [row('q1', 'answered'), row('q4', 'answered')])).toEqual([])
    expect(otherIds(fees)).toEqual(['q4'])
    expect(otherIds(group('q2'))).toEqual([])
  })

  it('the count on Assistant: open question groups, not flagged calls', () => {
    const rows = [
      row('q1', 'open', 'What is the status of my order number 4471?'),
      row('q2', 'open', 'Can I check the status of my order?'),
      row('q3', 'open', 'Do you work on Sundays?'),
      row('q4', 'answered', 'Is parking free?'),
      // The same question to another assistant is its own group.
      row('q5', 'open', 'Do you work on Sundays', 'as_2'),
    ]
    expect(openGroupCount(rows)).toBe(3)
    expect(openGroupCount(rows, 'as_1')).toBe(2)
    expect(openGroupCount([])).toBe(0)
  })
})

describe('questionKey: the same question, however it was put', () => {
  const same = (a: string, b: string) => expect(questionKey(a)).toBe(questionKey(b))
  const different = (a: string, b: string) => expect(questionKey(a)).not.toBe(questionKey(b))

  it('ignores case, punctuation, spacing, word order and filler words', () => {
    same('Do you service tankless water heaters?', 'do you service  tankless water heaters')
    same('DO YOU SERVICE TANKLESS WATER HEATERS?!', 'Do you service tankless water heaters')
    same('Is there a call-out fee?', 'What is the call-out fee?')
    same('What are your hours?', "What're your hours")
  })

  it('ignores an order or reference number and plural endings', () => {
    same('What is the status of my order number 4471?', 'Can you provide the status of my order number 4821?')
    same('What is the status of order number 4821?', 'Can I check the status of my order?')
    same('What are your fees for drain cleaning?', 'What is your fee for drain cleaning?')
  })

  it('keeps different questions apart, and differently worded ones about the same thing too', () => {
    different('Do you work on Sundays?', 'Do you work on Saturdays?')
    different('Where is my order?', 'What is the status of my order?')
    different('Do you charge a call-out fee?', 'Is there a call-out fee?')
    different('Are you open 24/7?', 'Are you open?')
  })

  it('a question of filler words only keeps its plain wording', () => {
    expect(questionKey('Can you?')).toBe('can you')
  })
})
