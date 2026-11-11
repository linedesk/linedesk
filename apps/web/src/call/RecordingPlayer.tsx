import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { clock } from '../time.ts'
import { RECORDINGS_NOT_KEPT } from '@linedesk/actions'
import { useWorkspaceSettings } from '../settings/settings-api.ts'
import { Icon } from '../ui/kit.tsx'
import { nextSpeed, recordingLength, registerPlayer, SEEK_STEP_SECONDS, seekSeconds } from './playback.ts'

type Props = { callId: string; callDurationSec: number | null }

/** Plays the call's recording: play or pause (Space), seek, speed, elapsed and total time. */
export function RecordingPlayer({ callId, callDurationSec }: Props) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [reportedLength, setReportedLength] = useState(Number.NaN)
  const [speed, setSpeed] = useState(1)
  const [dragging, setDragging] = useState(false)
  const [failed, setFailed] = useState(false)
  const length = recordingLength(reportedLength, callDurationSec)

  function toggle() {
    const el = audio.current
    if (!el || failed) return
    if (el.paused) void el.play().catch(() => setFailed(true))
    else el.pause()
  }
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  useEffect(() => registerPlayer(() => toggleRef.current()), [])

  function seek(seconds: number) {
    const to = Math.max(0, Math.min(length, seconds))
    if (audio.current) audio.current.currentTime = to
    setPosition(to)
  }
  function changeSpeed() {
    const next = nextSpeed(speed)
    if (audio.current) audio.current.playbackRate = next
    setSpeed(next)
  }
  const seekTo = (e: PointerEvent<HTMLDivElement>) => {
    const track = e.currentTarget.getBoundingClientRect()
    seek(seekSeconds(e.clientX, track.left, track.width, length))
  }
  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    seekTo(e)
  }
  function onTrackKey(e: KeyboardEvent) {
    const step = { ArrowRight: SEEK_STEP_SECONDS, ArrowLeft: -SEEK_STEP_SECONDS }[e.key]
    if (step) { e.preventDefault(); e.stopPropagation(); seek(position + step) }
    else if (e.key === 'Home') seek(0)
    else if (e.key === 'End') seek(length)
  }

  const played = length ? Math.min(1, position / length) : 0
  return (
    <section className="vn" aria-label="Recording">
      {/* biome-ignore lint/a11y/useMediaCaption: the transcript below is the text of this recording */}
      <audio ref={audio} src={`/v1/calls/${callId}/recording`} preload="metadata"
        onLoadedMetadata={e => { setFailed(false); setReportedLength(e.currentTarget.duration) }}
        onDurationChange={e => setReportedLength(e.currentTarget.duration)}
        onTimeUpdate={e => { if (!dragging) setPosition(e.currentTarget.currentTime) }}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onError={() => { setFailed(true); setPlaying(false) }} />
      <button type="button" className="vn-btn" disabled={failed} aria-label={playing ? 'Pause' : 'Play recording'} title={`${playing ? 'Pause' : 'Play'} (Space)`} onClick={toggle}>
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      <div className="vn-body">
        {failed ? <span className="help">The recording could not be loaded.</span> : (
          <div className="vn-track" role="slider" tabIndex={0} aria-label="Position in the recording" aria-valuemin={0} aria-valuemax={Math.round(length)}
            aria-valuenow={Math.round(position)} aria-valuetext={`${clock(position)} of ${clock(length)}`}
            onPointerDown={onPointerDown} onPointerMove={e => { if (dragging && e.buttons & 1) seekTo(e) }}
            onPointerUp={() => setDragging(false)} onPointerCancel={() => setDragging(false)} onLostPointerCapture={() => setDragging(false)}
            onKeyDown={onTrackKey}>
            <span className="vn-line"><span className="vn-played" style={{ width: `${played * 100}%` }} /></span>
            <span className="vn-knob" style={{ left: `${played * 100}%` }} />
          </div>
        )}
      </div>
      <span className="vn-time">{clock(position)} / {clock(length)}</span>
      <button type="button" className="vn-speed" aria-label={`Playback speed ${speed}x`} onClick={changeSpeed}>{speed}×</button>
    </section>
  )
}

/** In place of the player when the workspace keeps no recordings (Settings, Recordings: Don't keep). */
export function RecordingNotKept() {
  const settings = useWorkspaceSettings().data
  if (!settings?.recordingOn || settings.recordingRetentionDays !== RECORDINGS_NOT_KEPT) return null
  return (
    <p className="cv-no-recording" title="Settings, Recordings: Don't keep">
      Recording not kept
    </p>
  )
}
