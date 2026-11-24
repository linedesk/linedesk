// "No number is free in that area code" with the way out (LIN-313): one click searches the area code's overlays and the
// nearby codes at the carrier (phoneNumber.searchNearby, free, buys nothing) and lists those with a free number. Picking
// one puts it in the area code field; buying stays the screen's own button and confirmation. Used by onboarding's phone
// step and Settings › Phone numbers.
import { areaCodeLabel, buyableAreaCode, type NearbyNumbersData, nearbyAreaCodes } from '@linedesk/actions'
import { useFormat, useT } from '@linedesk/i18n/react'
import { useState } from 'react'
import { Button, Note } from '../ui/kit.tsx'
import { readAction } from './settings-api.ts'

type Props = {
  /** The area code that had no free number. The note goes away when it changes (the error is cleared), so a new one searches anew. */
  areaCode: string
  /** The "no number free" sentence, shown as the note's text. */
  message: string
  /** A code with a free number was picked. */
  onPick: (code: string) => void
}

type Search = { state: 'idle' } | { state: 'busy' } | { state: 'failed' } | { state: 'done'; data: NearbyNumbersData }

export function NearbyAreaCodes({ areaCode, message, onPick }: Props) {
  const t = useT()
  const format = useFormat()
  const [search, setSearch] = useState<Search>({ state: 'idle' })
  const candidates = nearbyAreaCodes(areaCode).map(a => a.code)

  async function run() {
    setSearch({ state: 'busy' })
    try {
      setSearch({ state: 'done', data: await readAction<NearbyNumbersData>('phoneNumber.searchNearby', { areaCode }) })
    } catch {
      setSearch({ state: 'failed' })
    }
  }

  const done = search.state === 'done' ? search.data : null
  // Nothing to search for a place without overlays or neighbours (Alaska, Hawaii): the message alone.
  const action = candidates.length > 0 && !done && (
    <Button
      size="sm"
      busy={search.state === 'busy'}
      onClick={() => void run()}
      title={t('settings.areaCode.nearby.searchTip', { codes: format.list(candidates) })}
    >
      {t('settings.areaCode.nearby.search')}
    </Button>
  )
  return (
    <>
      <Note tone="danger" action={action}>
        {message}
        {search.state === 'failed' && <> {t('settings.areaCode.nearby.failed')}</>}
      </Note>
      {done && (
        <div className="ac-nearby" role="group" aria-label={t('settings.areaCode.nearby.found')}>
          {done.free.length ? (
            <>
              <p className="ac-nearby-t">{t('settings.areaCode.nearby.found')}</p>
              <div className="ac-nearby-list">
                {done.free.map(f => {
                  const a = buyableAreaCode(f.code)
                  return (
                    <Button
                      key={f.code}
                      size="sm"
                      variant="ghost"
                      className="ac-nearby-opt"
                      onClick={() => onPick(f.code)}
                    >
                      {a ? areaCodeLabel(a) : f.code}
                      {f.sameArea && <span className="ac-nearby-tag">{t('settings.areaCode.nearby.sameArea')}</span>}
                    </Button>
                  )
                })}
              </div>
            </>
          ) : (
            <p className="ac-nearby-t">{t('settings.areaCode.nearby.none', { codes: format.list(done.searched) })}</p>
          )}
        </div>
      )}
    </>
  )
}
