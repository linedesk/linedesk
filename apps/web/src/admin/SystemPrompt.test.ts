import { PROMPT_TEXT_KEYS, PROMPT_TEXTS } from '@linedesk/actions'
import { describe, expect, it } from 'vitest'
import { joinText, splitText, textInUse, VARIABLES } from './SystemPrompt.tsx'

describe('System prompt page (LIN-346)', () => {
  it('splits a text into editable pieces around its variables and joins it back unchanged', () => {
    expect(splitText('Hi {name}, it is {now}.')).toEqual({
      texts: ['Hi ', ', it is ', '.'],
      variables: ['name', 'now'],
    })
    expect(splitText('{rules}')).toEqual({ texts: ['', ''], variables: ['rules'] })
    for (const key of PROMPT_TEXT_KEYS) {
      const { texts, variables } = splitText(PROMPT_TEXTS[key].text)
      expect(joinText(texts, variables)).toBe(PROMPT_TEXTS[key].text)
    }
  })

  it('has a label for every variable of every part', () => {
    const variables = PROMPT_TEXT_KEYS.flatMap(key => splitText(PROMPT_TEXTS[key].text).variables)
    expect(variables.filter(name => !VARIABLES[name])).toEqual([])
  })

  it('shows the edit while it fits, else the default', () => {
    const edit = {
      key: 'role.intro' as const,
      text: 'Be {name}.',
      defaultChanged: false,
      updatedAt: '',
      updatedBy: null,
    }
    expect(textInUse('role.intro', { ...edit, fits: true })).toBe('Be {name}.')
    expect(textInUse('role.intro', { ...edit, fits: false })).toBe(PROMPT_TEXTS['role.intro'].text)
    expect(textInUse('role.intro', undefined)).toBe(PROMPT_TEXTS['role.intro'].text)
  })
})
