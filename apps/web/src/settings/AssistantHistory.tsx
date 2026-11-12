// Settings › Assistant › History: every saved version of the assistant's call settings, newest first.
// Pick one to see what differs from now; "Restore this version" brings it back as a new version.
import {
  type AssistantRestoreData, type AssistantSnapshot, type AssistantVersionData, type AssistantVersionItem, type AssistantVersionsData,
  changedParts, type DiffLine, lineDiff, snapshotOf,
} from '@linedesk/actions'
import type { Assistant } from '@linedesk/db/types'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRows } from '../store.tsx'
import { dateTimeLabel, parseTs } from '../time.ts'
import { Dialog } from '../ui/form.tsx'
import { Button, cx } from '../ui/kit.tsx'
import { uniqueKeys } from '../ui/uniqueKeys.ts'
import { readAction, useWriteAction } from './settings-api.ts'
import { brandName } from '../brand.ts'

type Props = {
  assistant: Assistant
  /** Unsaved edits in the form: a restore would mix with them, so it waits until they are saved or discarded. */
  dirty: boolean
}

/** The History button next to "Start test call", and its panel. */
export function HistoryButton({ assistant, dirty }: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button icon="restart" onClick={() => setOpen(true)} title="Every saved version of these settings: compare and restore">
        History
      </Button>
      {open && <HistoryDialog assistant={assistant} dirty={dirty} onClose={() => setOpen(false)} />}
    </>
  )
}

/** Unchanged lines kept around a change; longer unchanged runs fold into "… n unchanged lines". */
const CONTEXT = 2

type Shown = DiffLine | { kind: 'fold'; count: number }

function folded(lines: DiffLine[]): Shown[] {
  const near = (i: number) => lines.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some(l => l.kind !== 'same')
  const out: Shown[] = []
  lines.forEach((line, i) => {
    if (line.kind !== 'same' || near(i)) return void out.push(line)
    const last = out.at(-1)
    if (last?.kind === 'fold') last.count++
    else out.push({ kind: 'fold', count: 1 })
  })
  return out
}

function PartDiff({ label, before, now }: { label: string; before: string; now: string }) {
  const shown = folded(lineDiff(before, now))
  const keys = uniqueKeys(shown.map(l => (l.kind === 'fold' ? `fold:${l.count}` : `${l.kind}:${l.text}`)))
  return (
    <section className="ah-part">
      <h4>{label}</h4>
      <div className="ah-lines">
        {shown.map((l, i) =>
          l.kind === 'fold' ? (
            <div key={keys[i]} className="ah-fold">
              {l.count} unchanged {l.count === 1 ? 'line' : 'lines'}
            </div>
          ) : (
            <div key={keys[i]} className={cx('ah-line', `ah-${l.kind}`)}>
              <span aria-hidden>{l.kind === 'old' ? '−' : l.kind === 'new' ? '+' : ' '}</span>
              <span className="sr-only">{l.kind === 'old' ? 'In this version: ' : l.kind === 'new' ? 'Now: ' : ''}</span>
              {l.text || ' '}
            </div>
          ),
        )}
      </div>
    </section>
  )
}

const byLine = (v: AssistantVersionItem) => [v.by ?? brandName(), dateTimeLabel(parseTs(v.created_at))].join(' · ')

function HistoryDialog({ assistant, dirty, onClose }: Props & { onClose: () => void }) {
  const write = useWriteAction()
  const calendars = useRows('assistant_calendars').filter(c => c.assistant_id === assistant.id)
  const now = useMemo(() => snapshotOf(assistant, calendars), [assistant, calendars])
  const [list, setList] = useState<AssistantVersionsData | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const [settings, setSettings] = useState<Record<number, AssistantSnapshot>>({})
  const [restoring, setRestoring] = useState(false)
  /** The last restore, so it can be undone from here: the version that was current before it. */
  const [restored, setRestored] = useState<{ from: number; as: number; previous: number | null; missing: string[] } | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await readAction<AssistantVersionsData>('assistant.versions', { assistantId: assistant.id })
      setList(data)
      // First the version before the current one: usually the question is "what did I just change?".
      setPicked(p => p ?? data.versions.find(v => v.number !== data.current)?.number ?? data.current)
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    }
  }, [assistant.id])
  useEffect(() => void load(), [load])

  useEffect(() => {
    if (picked == null || settings[picked]) return
    readAction<AssistantVersionData>('assistant.version', { assistantId: assistant.id, number: picked })
      .then(d => setSettings(s => ({ ...s, [picked]: d.version.settings })))
      .catch(e => setProblem(e instanceof Error ? e.message : String(e)))
  }, [assistant.id, picked, settings])

  async function restore(number: number, undoOf?: number) {
    setRestoring(true)
    setProblem(null)
    try {
      const previous = list?.current ?? null
      const data = await write<AssistantRestoreData>('assistant.restoreVersion', { assistantId: assistant.id, number })
      setRestored(undoOf ? null : { from: number, as: data.number, previous, missing: data.missingCalendars })
      await load()
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e))
    } finally {
      setRestoring(false)
    }
  }

  const version = list?.versions.find(v => v.number === picked)
  const old = picked != null ? settings[picked] : undefined
  const isCurrent = picked != null && picked === list?.current
  const parts = old ? changedParts(old, now) : []

  return (
    <Dialog
      title="History"
      description={`Every save is a version. Calls always use the newest; each call shows the version it ran with.`}
      onClose={onClose}
      size="lg"
      footer={
        <>
          {dirty && <span className="ah-note">Save or discard your changes first.</span>}
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            disabled={!old || isCurrent || dirty || restoring || !parts.length}
            onClick={() => picked != null && restore(picked)}
            title={isCurrent ? 'This is the version calls use now' : undefined}
          >
            {picked != null && !isCurrent ? `Restore version ${picked}` : 'Restore this version'}
          </Button>
        </>
      }
    >
      {restored && (
        <div className="ah-done" role="status">
          <span>
            Version {restored.from} is back, saved as version {restored.as}.
            {restored.missing.length > 0 && ` Not connected any more, so left out: ${restored.missing.join(', ')}.`}
          </span>
          {restored.previous != null && (
            <Button size="sm" disabled={restoring || dirty} onClick={() => restore(restored.previous!, restored.as)}>
              Undo
            </Button>
          )}
        </div>
      )}
      {problem && <p className="ah-problem">{problem}</p>}
      <div className="ah">
        <ol className="ah-list" aria-label="Versions">
          {!list && !problem && <li className="ah-empty">Loading…</li>}
          {list?.versions.map(v => (
            <li key={v.number}>
              <button type="button" className={cx('ah-item', v.number === picked && 'is-on')} aria-current={v.number === picked} onClick={() => setPicked(v.number)}>
                <span className="ah-item-top">
                  <b>Version {v.number}</b>
                  {v.number === list.current && <span className="ah-now">Now</span>}
                </span>
                <span className="ah-sum">{v.summary}</span>
                <span className="ah-by">{byLine(v)}</span>
              </button>
            </li>
          ))}
        </ol>
        <div className="ah-detail">
          {version && (
            <header className="ah-detail-head">
              <b>Version {version.number}</b>
              <span>{byLine(version)}</span>
            </header>
          )}
          {!old ? (
            picked != null && <p className="ah-empty">Loading…</p>
          ) : isCurrent ? (
            <p className="ah-empty">This is what calls use now.</p>
          ) : !parts.length ? (
            <p className="ah-empty">Same as now.</p>
          ) : (
            <>
              <p className="ah-legend">
                <span className="ah-old">− in version {picked}</span> <span className="ah-new">+ now</span>
              </p>
              {parts.map(p => (
                <PartDiff key={p.id} label={p.label} before={p.text(old)} now={p.text(now)} />
              ))}
            </>
          )}
        </div>
      </div>
    </Dialog>
  )
}
