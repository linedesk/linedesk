import { describe, expect, it } from 'vitest'
import { alignCallerLines, normalizeWord, type StoredLine } from './transcript-align.ts'

const line = (id: string, speaker: StoredLine['speaker'], text: string): StoredLine => ({ id, speaker, text })

// A staging call (three stages): what live speech recognition wrote, and what gpt-transcribe heard in the recording.
const call: StoredLine[] = [
  line(
    'a1',
    'agent',
    'Thanks for calling Brightwater Plumbing & Heating. This is Maya, the AI assistant. How can I help?',
  ),
  line('c1', 'caller', 'Are you open on Saturday?'),
  line('c2', 'caller', 'And what time do you open tomorrow'),
  line('a2', 'agent', 'The team will let you know about their hours. Is there anything else I can help you with?'),
  line('c3', 'caller', 'So what exact hours are you open'),
  line(
    'a3',
    'agent',
    "I'm sorry, I don't have the exact hours. Would you like me to take a message for the team to get back to you?",
  ),
  line('c4', 'caller', 'Yes, please. I need a callback about a leaking water heater. My name is Dana Reyes.'),
  line('s1', 'system', 'Took a message'),
  line('a4', 'agent', 'Could you please provide the callback number for Dana Reyes?'),
  line('c5', 'caller', 'You can reach me at five five five dash one two three dash seven eight nine zero.'),
  line(
    'a5',
    'agent',
    'It seems the number you gave is not valid. Can you please tell me the area code first for the callback number?',
  ),
  line('c6', 'caller', 'No. That is all for now. Thank you. Goodbye.'),
]
const heard =
  "Heating, this is Maya, the AI assistant. How can I help? Are you open on Saturday, and what time do you open tomorrow? The team will let you know about their hours. Is there anything else I can help you with? So what exact hours are you open? I'm sorry, I don't have the exact hours. Would you like me to take a message for the team to get back to you? Yes, please. I need a callback about a leaking water heater. My name is Dana Reyes. Could you please provide the callback number for Dana Reyes? You can reach me at 555-123-7890. It seems the number you gave is not valid. Can you please tell me the area code first for the callback number? No, that's all for now. Thank you. Goodbye."

describe('normalizeWord', () => {
  it('compares numbers digit by digit, whether written or spoken', () => {
    expect(normalizeWord('555-123')).toEqual(['5', '5', '5', '1', '2', '3'])
    expect(normalizeWord('Five')).toEqual(['5'])
    expect(normalizeWord('Heating,')).toEqual(['heating'])
    expect(normalizeWord('—')).toEqual([])
  })
})

describe('alignCallerLines', () => {
  it("replaces only the caller's lines, with the words heard between the assistant's lines", () => {
    const updates = Object.fromEntries(alignCallerLines(call, heard).map(u => [u.id, u.text]))
    expect(updates.c5).toBe('You can reach me at 555-123-7890.')
    expect(updates.c6).toBe("No, that's all for now. Thank you. Goodbye.")
    // Two lines heard as one sentence: split where the words fit.
    expect(updates.c1).toBe('Are you open on Saturday,')
    expect(updates.c2).toBe('and what time do you open tomorrow?')
    expect(updates.c3).toBe('So what exact hours are you open?')
    expect(Object.keys(updates).some(id => id.startsWith('a') || id.startsWith('s'))).toBe(false)
  })

  it('leaves a line that was heard the same unlisted', () => {
    expect(alignCallerLines(call, heard).map(u => u.id)).not.toContain('c4')
  })

  it("trusts nothing that does not contain the assistant's words", () => {
    expect(alignCallerLines(call, 'Completely different audio about something else entirely.')).toEqual([])
    expect(alignCallerLines(call, '')).toEqual([])
  })

  it('changes nothing without a caller line', () => {
    expect(alignCallerLines([line('a1', 'agent', 'Hello there')], 'Hello there friend')).toEqual([])
  })

  it('gives words heard where the live transcript has none to the caller line next to them', () => {
    const lines = [
      line('a1', 'agent', 'How can I help?'),
      line('c1', 'caller', 'My sink'),
      line('a2', 'agent', 'I can help with that.'),
    ]
    expect(alignCallerLines(lines, 'How can I help? My sink is leaking badly. I can help with that.')).toEqual([
      { id: 'c1', text: 'My sink is leaking badly.' },
    ])
  })

  it('drops words heard inside an assistant line', () => {
    const lines = [line('a1', 'agent', 'Your name is Dana Reyes. Is that right?'), line('c1', 'caller', 'yes')]
    expect(alignCallerLines(lines, 'Your name is Dana, uh, Reyes. Is that right? Yes.')).toEqual([
      { id: 'c1', text: 'Yes.' },
    ])
  })

  it("with speaker labels, the assistant's extra words stay out of the caller's line", () => {
    const lines = [
      line('a1', 'agent', 'Got it.'),
      line('c1', 'caller', 'my name is dana'),
      line('a2', 'agent', 'Thank you, Dana. Anything else?'),
      line('c2', 'caller', 'no'),
    ]
    const text = 'Got it, okay. My name is Dana Reyes. Thank you, Dana. Anything else? No, thanks.'
    // Plain text: the assistant's "okay" lands in the caller's line next to it.
    expect(alignCallerLines(lines, text)[0]).toEqual({ id: 'c1', text: 'okay. My name is Dana Reyes.' })
    const turns = [
      { speaker: '0', start: 0, text: 'Got it, okay.' },
      { speaker: '1', start: 900, text: 'My name is Dana Reyes.' },
      { speaker: '0', start: 2500, text: 'Thank you, Dana. Anything else?' },
      { speaker: '1', start: 4200, text: 'No, thanks.' },
    ]
    expect(alignCallerLines(lines, { text, turns })).toEqual([
      { id: 'c1', text: 'My name is Dana Reyes.' },
      { id: 'c2', text: 'No, thanks.' },
    ])
  })

  it('ignores speaker labels when no speaker sounds like the assistant', () => {
    const lines = [
      line('a1', 'agent', 'How can I help?'),
      line('c1', 'caller', 'my sink'),
      line('a2', 'agent', 'I can help with that.'),
    ]
    const turns = [{ speaker: '0', start: 0, text: 'How can I help? My sink is leaking badly. I can help with that.' }]
    expect(alignCallerLines(lines, { text: turns[0]!.text, turns })).toEqual([
      { id: 'c1', text: 'My sink is leaking badly.' },
    ])
  })
})
