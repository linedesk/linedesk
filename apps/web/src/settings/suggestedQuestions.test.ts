import type { MailTopic } from '@linedesk/actions'
import { expect, test } from 'vitest'
import { openSuggestions } from './SuggestedQuestions.tsx'

const topic = (title: string, conversations: number, review?: MailTopic['review']): MailTopic => ({
  title,
  conversations,
  example: `${title}?`,
  answer: `About ${title}.`,
  ...(review ? { review } : {}),
})

test('suggestions: the topics not yet reviewed, most support emails first, with their index in the analysis', () => {
  const topics = [
    topic('Drains', 12),
    topic('Water heaters', 30),
    topic('Area', 5, { decision: 'accepted', at: '2026-11-24T08:00:00Z', by: 'u1', assistantId: 'as_1' }),
    topic('Gas smell', 8, { decision: 'dropped', at: '2026-11-24T08:00:00Z', by: 'u1' }),
  ]
  expect(openSuggestions(topics).map(s => [s.index, s.topic.title])).toEqual([
    [1, 'Water heaters'],
    [0, 'Drains'],
  ])
  expect(openSuggestions(undefined)).toEqual([])
})
