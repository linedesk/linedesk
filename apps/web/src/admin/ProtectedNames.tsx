// Server admin › Sign-up & access › Protected names (docs/white-label.md, S4): the names a white-label partner's brand may not
// use or contain, so a partner cannot send this install's emails as a bank or as this product. One name per line;
// "Use the built-in list" goes back to the list the server ships with.
import type { ProtectedNamesData } from '@linedesk/actions'
import { useT } from '@linedesk/i18n/react'
import { type FormEvent, useState } from 'react'
import { useQuery } from '../cachedQuery.ts'
import { useSupportAccess } from '../supportAccess.ts'
import { Card, FormField, Textarea } from '../ui/form.tsx'
import { Button, Note } from '../ui/kit.tsx'
import { Loading, SkeletonRows } from '../ui/LoadStates.tsx'
import { runAdmin } from './api.ts'
import { errorText, type Notify } from './notify.ts'

const QUERY = 'admin.partners.protectedNames'
const load = async () => (await runAdmin('partnerBrand.protectedNames', {})) as ProtectedNamesData

/** The names in the box: one per line, blank lines and repeats left out. */
export const namesOf = (text: string) => [
  ...new Set(
    text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
  ),
]

export function ProtectedNames({ notify }: { notify: Notify }) {
  const t = useT()
  const supportAccess = useSupportAccess()
  const query = useQuery(supportAccess ? null : QUERY, load)
  const [text, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const saved = query.data?.names.join('\n') ?? ''
  const shown = text ?? saved
  const dirty = text !== null && namesOf(text).join('\n') !== saved
  // An empty list lets every name through, also a bank's or this product's (security review of #1111, M-1).
  const empty = query.data ? namesOf(shown).length === 0 : false

  async function save(names: string[] | null) {
    setBusy(true)
    setProblem(null)
    try {
      await runAdmin('partnerBrand.setProtectedNames', { names })
      notify(names ? t('admin.partners.protected.saved') : t('admin.partners.protected.reset'))
      setText(null)
      await query.reload()
    } catch (err) {
      setProblem(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (dirty && !busy) void save(namesOf(shown))
  }

  return (
    <Card title={t('admin.partners.protected.title')} description={t('admin.partners.protected.description')}>
      <Loading
        what={t('admin.partners.protected.title')}
        loading={!query.data && !supportAccess}
        error={query.error}
        onRetry={() => void query.reload()}
        skeleton={<SkeletonRows rows={2} columns={1} />}
      >
        <form className="adm-form" onSubmit={submit}>
          {empty && <Note tone="warning">{t('admin.partners.protected.empty')}</Note>}
          <FormField
            id="adm-protected-names"
            label={t('admin.partners.protected.label')}
            description={query.data?.builtIn ? t('admin.partners.protected.builtIn') : undefined}
            error={problem}
          >
            <Textarea id="adm-protected-names" rows={5} value={shown} onChange={e => setText(e.target.value)} />
          </FormField>
          <div className="adm-actbar">
            <Button type="submit" busy={busy} disabled={supportAccess || !dirty}>
              {t('admin.partners.protected.save')}
            </Button>
            {query.data && !query.data.builtIn && (
              <Button variant="ghost" disabled={supportAccess || busy} onClick={() => void save(null)}>
                {t('admin.partners.protected.useBuiltIn')}
              </Button>
            )}
          </div>
        </form>
      </Loading>
    </Card>
  )
}
