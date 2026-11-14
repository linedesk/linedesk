import type { CallEvaluation, QuestionGroup } from '@linedesk/actions'
import type { KnowledgeQuestion } from '@linedesk/db/types'
import { describe, expect, it } from 'vitest'
import {
  askedLabel,
  checkLabel,
  listToggleLabel,
  needsALook,
  openGroups,
  openItemCount,
  reviewTitle,
  scoreWords,
  withCall,
  withoutCall,
} from './reviewModel.ts'

const evaluation = (callId: string, createdAt: string, score = 2): CallEvaluation => ({
  callId,
  score,
  issues: [],
  unanswered: [],
  model: null,
  createdAt,
  reviewedAt: null,
  reviewedBy: null,
})

describe('How the assistant did', () => {
  it('names the section after the assistant', () => {
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

  it('says Mark as checked and Show checked, never Done (the call has its own Done)', () => {
    expect(checkLabel(false)).toBe('Mark as checked')
    expect(checkLabel(true)).toBe('Reopen')
    expect(listToggleLabel(false)).toBe('Show checked')
    expect(listToggleLabel(true)).toBe('Show open')
  })

  it('Mark as checked takes the call off the open list and onto the checked list, newest first; Reopen the other way', () => {
    const a = evaluation('a', '2026-11-14T10:00:00Z')
    const b = evaluation('b', '2026-11-13T10:00:00Z')
    const open = { evaluations: [a, b], total: 7 }
    expect(withoutCall(open, 'a')).toEqual({ evaluations: [b], total: 6 })
    expect(withoutCall(open, 'x')).toBe(open)
    expect(withoutCall(undefined, 'a')).toBeUndefined()
    expect(withCall({ evaluations: [b], total: 6 }, a)).toEqual({ evaluations: [a, b], total: 7 })
    // Already there: replaced, not counted twice.
    expect(withCall(open, { ...a, reviewedAt: 'now' })).toEqual({
      evaluations: [{ ...a, reviewedAt: 'now' }, b],
      total: 7,
    })
  })
})

describe("Questions the assistant couldn't answer", () => {
  const group = (questionId: string, asked = 1): QuestionGroup => ({
    questionId,
    assistantId: 'as_1',
    question: questionId,
    asked,
    callIds: [],
    lastAskedAt: '2026-11-14T10:00:00Z',
  })
  const row = (id: string, status: KnowledgeQuestion['status']) => ({ id, status }) as KnowledgeQuestion

  it('says how often a question was asked', () => {
    expect(askedLabel(1)).toBe('Asked once')
    expect(askedLabel(3)).toBe('Asked 3×')
  })

  it('a group answered or dismissed on this device leaves at once; one not synced yet stays', () => {
    const groups = [group('q1', 3), group('q2'), group('q3')]
    expect(openGroups(groups, [row('q1', 'answered'), row('q2', 'open'), row('q9', 'dismissed')])).toEqual([
      group('q2'),
      group('q3'),
    ])
  })

  it('the count on Assistant: open calls to look at plus open questions', () => {
    expect(openItemCount(2, [row('q1', 'open'), row('q2', 'answered'), row('q3', 'open')])).toBe(4)
    expect(openItemCount(0, [])).toBe(0)
  })
})
