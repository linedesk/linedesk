import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { FRAME_START, type FrameInput, frameAfter, frameClass, ImageCrop } from './ImageCrop.tsx'

const through = (...inputs: FrameInput[]) => inputs.reduce(frameAfter, FRAME_START)

describe('the "Drag to move" hint', () => {
  test('shows until the image first moves', () => {
    expect(FRAME_START.moved).toBe(false)
    expect(through('press').moved).toBe(false)
    expect(through('press', 'release').moved).toBe(false)
  })

  test('hides after a pointer drag and stays hidden', () => {
    expect(through('press', 'drag').moved).toBe(true)
    expect(through('press', 'drag', 'release', 'press', 'release').moved).toBe(true)
  })

  test('hides after an arrow key, the wheel, a pinch or + / −', () => {
    for (const input of ['key-move', 'wheel', 'pinch', 'key-zoom'] as const) expect(through(input).moved).toBe(true)
  })

  test('stays after the slider, which says nothing about dragging', () => {
    expect(through('slider').moved).toBe(false)
  })
})

describe('the cursor', () => {
  test('grab over the image, grabbing while held', () => {
    expect(frameClass('circle', FRAME_START)).toBe('k-crop-frame is-circle')
    expect(frameClass('circle', through('press'))).toBe('k-crop-frame is-circle is-dragging')
    expect(frameClass('rounded-square', through('press', 'drag'))).toBe('k-crop-frame is-rounded-square is-dragging')
    expect(frameClass('circle', through('press', 'drag', 'release'))).toBe('k-crop-frame is-circle')
  })
})

describe('ImageCrop', () => {
  // Rendered on the server: the backdrop reads the focused element when it opens.
  const saved = globalThis.document
  beforeAll(() => {
    globalThis.document = { activeElement: null } as unknown as Document
  })
  afterAll(() => {
    globalThis.document = saved
  })

  const html = () =>
    renderToStaticMarkup(
      <ImageCrop
        file={new File(['x'], 'me.png', { type: 'image/png' })}
        shape="circle"
        title="Profile picture"
        size={512}
        maxBytes={1_000_000}
        what="The picture"
        onCancel={() => {}}
        onSave={async () => {}}
      />,
    )

  test('says how to move and zoom, for pointers, touch and screen readers', () => {
    const out = html()
    expect(out).toContain('Drag the picture to move it. Use the slider, scroll or pinch to zoom.')
    expect(out).toContain('Drag to move, pinch to zoom.')
    const describedBy = out.match(/aria-describedby="([^"]+)"/)?.[1]
    expect(describedBy).toBeTruthy()
    expect(out).toContain(`id="${describedBy}" class="sr-only">Drag the image or use the arrow keys to move it`)
    expect(out).toContain('class="k-crop-frame is-circle"')
  })
})
