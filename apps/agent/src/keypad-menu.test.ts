import type { KeypadMenu } from '@linedesk/db/types'
import { expect, test } from 'vitest'
import { activeMenu, menuChoice, menuPrompt } from './keypad-menu.ts'

const menu: KeypadMenu = {
  options: [
    { key: '2', label: 'billing', action: 'topic' },
    { key: '1', label: 'emergencies', action: 'transfer' },
  ],
}

test('the menu is off unless the assistant has options', () => {
  expect(activeMenu(null)).toBeNull()
  expect(activeMenu({ keypad_menu: null })).toBeNull()
  expect(activeMenu({ keypad_menu: { options: [] } })).toBeNull()
  expect(activeMenu({ keypad_menu: menu })).toBe(menu)
})

test('the caller hears the keys in order and that speaking works too', () => {
  expect(menuPrompt(menu)).toBe('For emergencies, press 1. For billing, press 2. Or just tell me how I can help.')
})

test('a transfer key is an urgent call: transfer when it is on, else flagged and a message', () => {
  expect(menuChoice(menu, '1', true)).toEqual({ event: 'Pressed 1 · emergencies', instructions: expect.stringMatching(/transfer_call/) })
  expect(menuChoice(menu, '1', false)?.instructions).toMatch(/flag_urgent.*take a message/)
})

test('a topic key tells the assistant what the call is about; other keys are not on the menu', () => {
  expect(menuChoice(menu, '2', true)?.instructions).toMatch(/calling about billing/)
  expect(menuChoice(menu, '3', true)).toBeNull()
})
