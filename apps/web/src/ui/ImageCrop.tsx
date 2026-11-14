// The crop step after picking an image (the profile picture, the workspace icon): the image in a square frame with
// the shape it is shown in (a circle for a person, a rounded square for a workspace), dragged to move, zoomed with
// the slider, a pinch or the wheel; arrow keys move, + and − zoom, Enter saves. Saving cuts the kept square out in
// the browser at up to `size` pixels and hands the PNG to `onSave`; only that square is stored, not the original.
// No library: the math is in cropMath.ts. That the image moves is said three times, quietly: the grab cursor, a
// "Drag to move" hint on the picture until it first moves, and a muted line under the slider.
import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from 'react'
import {
  type Crop,
  clampCrop,
  cropOutput,
  defaultCrop,
  type ImageSize,
  imagePlacement,
  MAX_ZOOM,
  panCrop,
  zoomCrop,
} from './cropMath.ts'
import { Dialog } from './form.tsx'
import { canvasAsPng } from './imageAsPng.ts'
import { Button, cx, Icon, Note } from './kit.tsx'

/** The frame's side in CSS pixels. */
const FRAME = 280
/** Arrow keys move the image this many frame pixels (Shift: five times as far). */
const KEY_STEP = 8
/** + and − zoom by this factor. */
const KEY_ZOOM = 1.15

/** What the frame shows around the image: grabbing while held, and the "Drag to move" hint until the image moved. */
export type FrameState = { dragging: boolean; moved: boolean }
/**
 * What happened on the frame: a pointer went down or the last one came up, the image was dragged, pinched or
 * wheeled, an arrow key moved it or + / − zoomed it, or the slider zoomed it.
 */
export type FrameInput = 'press' | 'release' | 'drag' | 'pinch' | 'wheel' | 'key-move' | 'key-zoom' | 'slider'
export const FRAME_START: FrameState = { dragging: false, moved: false }

/**
 * The frame after an input. Every way of moving the image on the frame itself hides the hint for good; the slider
 * doesn't, since it says nothing about dragging.
 */
export function frameAfter(state: FrameState, input: FrameInput): FrameState {
  if (input === 'press') return state.dragging ? state : { ...state, dragging: true }
  if (input === 'release') return state.dragging ? { ...state, dragging: false } : state
  if (input === 'slider' || state.moved) return state
  return { ...state, moved: true }
}

/** The frame's classes: its shape, and the grabbing cursor while held (grab otherwise, from the stylesheet). */
export const frameClass = (shape: Props['shape'], state: FrameState) =>
  cx('k-crop-frame', `is-${shape}`, state.dragging && 'is-dragging')

type Props = {
  file: File
  /** How the result is shown: a person's round picture, or a workspace's rounded square. */
  shape: 'circle' | 'rounded-square'
  title: string
  /** The saved square's largest side, and its largest PNG (the server's limits). */
  size: number
  maxBytes: number
  /** "The picture", "The icon": the start of the too-large message. */
  what: string
  onCancel: () => void
  /** Saves the PNG; throws to show why it failed. The dialog stays open until it resolves. */
  onSave: (png: string) => Promise<void>
}

export function ImageCrop({ file, shape, title, size, maxBytes, what, onCancel, onSave }: Props) {
  // The file's address for the <img>, made and released with the effect (also when React runs it twice in dev).
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const made = URL.createObjectURL(file)
    setUrl(made)
    return () => URL.revokeObjectURL(made)
  }, [file])
  const imageRef = useRef<HTMLImageElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [image, setImage] = useState<ImageSize | null>(null)
  const [crop, setCrop] = useState<Crop | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The pointers on the frame now: one drags, two pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const [frame, setFrame] = useState(FRAME_START)
  const note = (input: FrameInput) => setFrame(state => frameAfter(state, input))
  const helpId = useId()

  // Focus starts on the frame, so the arrow keys move the image at once.
  useEffect(() => frameRef.current?.focus(), [])

  function loaded() {
    const img = imageRef.current
    if (!img) return
    // An SVG without a size of its own is drawn as a square of the saved size.
    const known = { width: img.naturalWidth || size, height: img.naturalHeight || size }
    setImage(known)
    setCrop(defaultCrop(known))
  }

  const update = (next: (image: ImageSize, crop: Crop) => Crop) => {
    if (image && crop) setCrop(next(image, crop))
  }
  const pointIn = (e: { clientX: number; clientY: number }) => {
    const box = frameRef.current!.getBoundingClientRect()
    return { x: e.clientX - box.left, y: e.clientY - box.top }
  }

  function onPointerDown(e: PointerEvent<HTMLDivElement>) {
    if (!crop) return
    e.currentTarget.setPointerCapture(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    note('press')
  }
  function onPointerMove(e: PointerEvent<HTMLDivElement>) {
    const last = pointers.current.get(e.pointerId)
    if (!last) return
    const now = { x: e.clientX, y: e.clientY }
    const others = [...pointers.current].filter(([id]) => id !== e.pointerId).map(([, p]) => p)
    if (others.length === 0) {
      if (now.x === last.x && now.y === last.y) return
      update((i, c) => panCrop(i, c, now.x - last.x, now.y - last.y, FRAME))
      note('drag')
    } else {
      const other = others[0]!
      const before = Math.hypot(last.x - other.x, last.y - other.y)
      const after = Math.hypot(now.x - other.x, now.y - other.y)
      const middle = pointIn({ clientX: (now.x + other.x) / 2, clientY: (now.y + other.y) / 2 })
      if (before > 0 && after !== before) {
        update((i, c) => zoomCrop(i, c, (c.zoom * after) / before, FRAME, middle))
        note('pinch')
      }
    }
    pointers.current.set(e.pointerId, now)
  }
  function onPointerUp(e: PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size === 0) note('release')
  }

  // The wheel zooms around the pointer; a listener of its own, since React's wheel events can't stop the page scroll.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {})
  wheelRef.current = e => {
    e.preventDefault()
    const at = pointIn(e)
    update((i, c) => zoomCrop(i, c, c.zoom * Math.exp(-e.deltaY * 0.002), FRAME, at))
    note('wheel')
  }
  useEffect(() => {
    const frame = frameRef.current
    const onWheel = (e: WheelEvent) => wheelRef.current(e)
    frame?.addEventListener('wheel', onWheel, { passive: false })
    return () => frame?.removeEventListener('wheel', onWheel)
  }, [])

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? KEY_STEP * 5 : KEY_STEP
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }
    const move = moves[e.key]
    if (move) {
      update((i, c) => panCrop(i, c, move[0], move[1], FRAME))
      note('key-move')
    } else if (e.key === '+' || e.key === '=') {
      update((i, c) => zoomCrop(i, c, c.zoom * KEY_ZOOM, FRAME))
      note('key-zoom')
    } else if (e.key === '-' || e.key === '_') {
      update((i, c) => zoomCrop(i, c, c.zoom / KEY_ZOOM, FRAME))
      note('key-zoom')
    } else if (e.key === 'Enter') void save()
    else return
    e.preventDefault()
  }

  async function save() {
    const img = imageRef.current
    if (!image || !crop || !img || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const { sx, sy, side, out } = cropOutput(image, crop, size)
      const canvas = document.createElement('canvas')
      canvas.width = out
      canvas.height = out
      const context = canvas.getContext('2d')!
      if (img.naturalWidth && img.naturalHeight) context.drawImage(img, sx, sy, side, side, 0, 0, out, out)
      else {
        // No size of its own (an SVG): drawn at `image`'s size, then the square is cut out of that.
        const scale = out / side
        context.drawImage(img, -sx * scale, -sy * scale, image.width * scale, image.height * scale)
      }
      await onSave(canvasAsPng(canvas, { maxBytes, what }))
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'Could not save the image. Try again.')
      setBusy(false)
    }
  }

  const placed = image && crop ? imagePlacement(image, crop, FRAME) : null
  const zoomMax = image ? clampCrop(image, { cx: 0, cy: 0, zoom: MAX_ZOOM }).zoom : MAX_ZOOM
  return (
    <Dialog
      title={title}
      size="sm"
      onClose={busy ? () => {} : onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy} title="Keep what is there now (esc)">
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            disabled={!crop || busy}
            onClick={() => void save()}
            title="Save (enter)"
          >
            Save
          </Button>
        </>
      }
    >
      <div className="k-crop">
        <div
          ref={frameRef}
          className={frameClass(shape, frame)}
          style={{ width: FRAME, height: FRAME }}
          role="group"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the frame takes the arrow and +/− keys that move and zoom the image; no native element does
          tabIndex={0}
          aria-label="Image position"
          aria-describedby={helpId}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        >
          <img
            ref={imageRef}
            src={url ?? undefined}
            alt=""
            draggable={false}
            onLoad={loaded}
            onError={() => setProblem('That file is not an image this browser can read. Use a PNG, JPEG, WebP or SVG.')}
            style={
              placed
                ? { left: placed.left, top: placed.top, width: placed.width, height: placed.height }
                : { opacity: 0 }
            }
          />
          <span className="k-crop-mask" aria-hidden="true" />
          {crop && (
            <span className={cx('k-crop-hint', frame.moved && 'is-hidden')} aria-hidden="true">
              <Icon name="move" size={16} />
              Drag to move
            </span>
          )}
        </div>
        <label className="k-crop-zoom">
          <span>Zoom</span>
          <input
            type="range"
            min={1}
            max={zoomMax}
            step={0.01}
            value={crop?.zoom ?? 1}
            disabled={!crop}
            aria-valuetext={`${Math.round((crop?.zoom ?? 1) * 100)}%`}
            onChange={e => {
              update((i, c) => zoomCrop(i, c, Number(e.target.value), FRAME))
              note('slider')
            }}
          />
        </label>
        <p className="k-crop-help">
          <span className="k-crop-help-pointer">
            Drag the picture to move it. Use the slider, scroll or pinch to zoom.
          </span>
          <span className="k-crop-help-touch">Drag to move, pinch to zoom.</span>
          <span id={helpId} className="sr-only">
            Drag the image or use the arrow keys to move it, Shift with an arrow key moves it farther. Use + and − or
            the zoom slider to zoom.
          </span>
        </p>
        {problem && <Note tone="danger">{problem}</Note>}
      </div>
    </Dialog>
  )
}
