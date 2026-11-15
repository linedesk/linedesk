// The fixed texts for the team follow the workspace language, the closest one the app has a catalog for.
import { expect, test } from 'vitest'
import { teamT } from './team-text.ts'

test('the team language picks the catalog: es is Spanish, pt is Brazilian Portuguese, one without a catalog is English', () => {
  // A key every catalog has had for a while; the new autoSummary keys get their translations in the release pass.
  expect(teamT('es')('call.empty.hungUp')).toBe('Quien llamó colgó sin decir nada.')
  expect(teamT('de')('call.empty.hungUp')).toBe('Der Anrufer hat aufgelegt, ohne etwas zu sagen.')
  expect(teamT('pt')('call.empty.hungUp')).toBe(teamT('pt-BR')('call.empty.hungUp'))
  expect(teamT('pt')('call.empty.hungUp')).not.toBe(teamT('en')('call.empty.hungUp'))
  expect(teamT('ko')('call.empty.hungUp')).toBe('The caller hung up without saying anything.')
  expect(teamT(undefined)('call.autoSummary.hungUp.summary')).toBe('The caller hung up without saying anything.')
})
