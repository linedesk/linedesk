import { describe, expect, it } from 'vitest'
import { changedKeys, humanLocales, usages } from './changed.ts'
import { checkBaselineEmpty, checkRatchet, checkUsage, type Report } from './check.ts'
import { type Glossary, hash, lockEntry, planLocale, structureErrors, validateTranslation } from './lib.ts'
import { updateLock } from './lock.ts'
import { countHardcoded, scanKeys } from './scan.ts'
import { styleFor } from './translate.ts'

const glossary: Glossary = { neverTranslate: ['Linedesk', 'Maya'], terms: {}, identical: { es: ['common.ok'] } }

describe('lock decisions', () => {
  const en = {
    'a.new': 'New text',
    'a.changed': 'Changed now',
    'a.human': 'Same',
    'a.humanChanged': 'New English',
    'a.ai': 'Kept',
  }
  const target = {
    'a.changed': 'Viejo',
    'a.human': 'Editado',
    'a.humanChanged': 'Persona',
    'a.ai': 'Igual',
    'a.gone': 'Fuera',
  }
  const lock = {
    'a.changed': lockEntry('Changed before', 'Viejo', 'ai'),
    'a.human': lockEntry('Same', 'Original de la IA', 'ai'),
    'a.humanChanged': lockEntry('Old English', 'Persona', 'human'),
    'a.ai': lockEntry('Kept', 'Igual', 'ai'),
    'a.gone': lockEntry('Gone', 'Fuera', 'ai'),
  }
  const plan = planLocale(en, target, lock)

  it('translates a new key and a key whose English changed', () => {
    expect(plan.translate).toEqual(['a.changed', 'a.new'])
  })
  it('keeps a person’s edit and marks it human', () => {
    expect(plan.humanEdits).toEqual(['a.human'])
  })
  it('translates a person’s text again only when the English changed, with theirs as reference', () => {
    expect(plan.retranslateHuman).toEqual(['a.humanChanged'])
  })
  it('removes keys English no longer has', () => {
    expect(plan.remove).toEqual(['a.gone'])
  })
  it('leaves a current AI translation alone', () => {
    expect([...plan.translate, ...plan.humanEdits, ...plan.retranslateHuman]).not.toContain('a.ai')
  })
})

describe('updateLock', () => {
  const en = { 'x.a': 'A text', 'x.b': 'B text' }
  it('records new strings as a person’s, --by ai records all matching, entries of removed keys go', () => {
    const old = { es: { 'x.a': lockEntry('A text', 'A', 'ai'), 'x.gone': lockEntry('G', 'g', 'ai') } }
    const plain = updateLock(old, en, { es: { 'x.a': 'A', 'x.b': 'B' } }, {})
    expect(plain.es?.['x.b']?.by).toBe('human')
    expect(plain.es?.['x.gone']).toBeUndefined()
    const ai = updateLock(old, en, { es: { 'x.a': 'A', 'x.b': 'B' } }, { by: 'ai' })
    expect(ai.es?.['x.b']).toEqual({ src: hash('B text'), out: hash('B'), by: 'ai' })
    const marked = updateLock(ai, en, { es: { 'x.a': 'A', 'x.b': 'B' } }, { by: 'human', locale: 'es', prefix: 'x.a' })
    expect(marked.es?.['x.a']?.by).toBe('human')
    expect(marked.es?.['x.b']?.by).toBe('ai')
  })
})

describe('ICU validation', () => {
  it('accepts a faithful translation', () => {
    expect(structureErrors('Call {name} <b>now</b>', 'Llama a {name} <b>ahora</b>', 'es')).toEqual([])
  })
  it('catches a missing argument', () => {
    expect(structureErrors('Call {name}', 'Llama', 'es')[0]).toMatch(/arguments differ/)
  })
  it('catches a renamed tag', () => {
    expect(structureErrors('A <b>B</b>', 'A <strong>B</strong>', 'es')[0]).toMatch(/tags differ/)
  })
  it('catches a missing plural category for the language', () => {
    const english = '{n, plural, one {# call} other {# calls}}'
    expect(structureErrors(english, '{n, plural, one {# llamada} other {# llamadas}}', 'es')).toEqual([
      'plural "n" misses many for es',
    ])
    expect(structureErrors(english, '{n, plural, other {#件}}', 'ja')).toEqual([])
    expect(structureErrors(english, '{n, plural, one {# Anruf}}', 'de')[0]).toMatch(/other/i)
  })
  it('catches invalid ICU', () => {
    expect(structureErrors('Hi {name}', 'Hola {name', 'es')[0]).toMatch(/not valid ICU/)
  })
  it('catches a changed glossary term and English left as it was', () => {
    expect(validateTranslation('k', 'Open Linedesk now', 'Abre Lindesk', 'es', glossary)).toContain(
      '"Linedesk" must stay as it is',
    )
    expect(validateTranslation('k', 'Save all your changes', 'Save all your changes', 'es', glossary)[0]).toMatch(
      /left in English/,
    )
    expect(validateTranslation('common.ok', 'This is fine here ok', 'This is fine here ok', 'es', glossary)).toEqual([])
  })
})

describe('key scan', () => {
  const source = `
    // i18n-dynamic: errors.*
    const a = t('inbox.title')
    const b = intl.t(cond ? 'inbox.one' : 'inbox.two')
    const c = msg('shell.nav.inbox')
    const d = <T k="call.summary" values={{}} />
    const e = t(\`errors.\${code}\`)
  `
  it('finds keys in t(), x.t(), msg(), <T k> and choices', () => {
    const scan = scanKeys('a.tsx', source)
    expect(scan.used.map(u => u.key).sort()).toEqual([
      'call.summary',
      'inbox.one',
      'inbox.title',
      'inbox.two',
      'shell.nav.inbox',
    ])
    expect(scan.dynamic).toEqual([{ prefix: 'errors.', file: 'a.tsx' }])
    expect(scan.undeclared).toEqual([])
  })
  it('reports unknown, unused and undeclared runtime keys', () => {
    const report: Report = { errors: [], warnings: [] }
    const scan = scanKeys('b.ts', 'const x = t(`inbox.$' + '{y}`); t("inbox.known"); t("inbox.typo")')
    checkUsage({ 'inbox.known': 'K', 'inbox.unused': 'U' }, [scan], report)
    expect(report.errors).toEqual([
      'b.ts:1: unknown key "inbox.typo"',
      expect.stringMatching(/key built at runtime/),
      'inbox.unused: defined in English but not used anywhere',
    ])
  })
})

describe('hardcoded ratchet', () => {
  it('counts JSX text, text attributes and toast() but not keys, brand names or symbols', () => {
    const source = `
      export function A() {
        toast('Saved.')
        return <div title="Open the call" className="row">
          Hello there <b>{t('inbox.title')}</b> · {'Plain'}
          <Kbd keys={['E']} /> Linedesk
          <input placeholder={t('x.y')} aria-label="Search calls" />
        </div>
      }`
    // toast, title, "Hello there", {'Plain'}, aria-label; not className, the key, "·", Kbd keys, "Linedesk".
    expect(countHardcoded('a.tsx', source, new Set(['Linedesk']))).toBe(5)
  })
  it('fails a file above its baseline, new files start at 0, reports lowered ones', () => {
    const report: Report = { errors: [], warnings: [] }
    const { lowered } = checkRatchet(
      { 'a.tsx': 3, 'b.tsx': 1, 'c.tsx': 1 },
      { 'a.tsx': 3, 'b.tsx': 0, 'c.tsx': 4 },
      report,
    )
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toMatch(/^b\.tsx: 1 hardcoded/)
    expect(lowered).toEqual(['c.tsx: 4 → 1'])
  })
  it('--complete: fails while the baseline lists any file, passes when it is empty', () => {
    const report: Report = { errors: [], warnings: [] }
    checkBaselineEmpty({ 'a.tsx': 2 }, report)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0]).toMatch(/^hardcoded-baseline\.json lists a\.tsx \(2\): .*use t\(\)/)
    const clean: Report = { errors: [], warnings: [] }
    checkBaselineEmpty({}, clean)
    expect(clean.errors).toEqual([])
  })
})

describe('styleFor', () => {
  it('sends the general part and only the language’s own section', () => {
    const style = '# Title\n\n## General\n\nShort.\n\n## es: Spanish\n\ntú\n\n## fr: French\n\nvous\n'
    const es = styleFor(style, 'es')
    expect(es).toContain('Short.')
    expect(es).toContain('tú')
    expect(es).not.toContain('vous')
  })
})

describe('lock --by ai and a person’s text', () => {
  const en = { 'a.kept': 'Same', 'a.redone': 'New English', 'a.mine': 'Mine' }
  const lock = {
    es: {
      'a.kept': lockEntry('Same', 'Hecho por una persona', 'human'),
      'a.redone': lockEntry('Old English', 'Persona', 'human'),
      'a.mine': lockEntry('Mine', 'Mío', 'ai'),
    },
  }
  const targets = { es: { 'a.kept': 'Hecho por una persona', 'a.redone': 'Nuevo texto', 'a.mine': 'Mío' } }
  const next = updateLock(lock, en, targets, { by: 'ai' })

  it('keeps a string written by a person when its text did not change', () => {
    expect(next.es?.['a.kept']).toEqual(lock.es['a.kept'])
  })
  it('records a rewritten text as the AI’s', () => {
    expect(next.es?.['a.redone']).toEqual(lockEntry('New English', 'Nuevo texto', 'ai'))
  })
})

describe('i18n:changed', () => {
  it('lists new keys and keys whose English changed, sorted', () => {
    const before = { 'b.same': 'Same', 'b.edited': 'Old', 'b.gone': 'Gone' }
    const now = { 'b.same': 'Same', 'b.edited': 'New', 'b.added': 'Added' }
    expect(changedKeys(before, now)).toEqual([
      { key: 'b.added', status: 'new' },
      { key: 'b.edited', status: 'changed' },
    ])
  })
  it('finds where each key is used, also under an i18n-dynamic prefix', () => {
    const scans = [
      scanKeys('apps/web/src/A.tsx', "const x = t('inbox.row.done')\n"),
      scanKeys('apps/web/src/B.tsx', '// i18n-dynamic: errors.*\nconst y = t(`errors.$' + '{code}`)\n'),
    ]
    expect(usages(['inbox.row.done', 'errors.timeout', 'shell.nowhere'], scans)).toEqual({
      'inbox.row.done': ['apps/web/src/A.tsx:1'],
      'errors.timeout': ['apps/web/src/B.tsx (errors.*)'],
      'shell.nowhere': [],
    })
  })
  it('names the languages where a person wrote the translation', () => {
    const lock = {
      de: { 'c.key': lockEntry('x', 'y', 'human') },
      es: { 'c.key': lockEntry('x', 'z', 'ai') },
    }
    expect(humanLocales(lock, 'c.key')).toEqual(['de'])
  })
})
