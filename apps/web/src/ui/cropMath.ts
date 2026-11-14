// The math of the crop step (ImageCrop.tsx): which square of the image is kept, kept inside the image, moved and
// zoomed by the frame's pixels. Pure, so it is tested without a browser.

/** The image's size in its own pixels. */
export type ImageSize = { width: number; height: number }

/** The kept square: its centre in image pixels, and the zoom (1 = the largest square that fits). */
export type Crop = { cx: number; cy: number; zoom: number }

/** How far one can zoom in: an eighth of the shorter side, never fewer pixels than one. */
export const MAX_ZOOM = 8

/** The side of the kept square, in image pixels. */
export const cropSide = (image: ImageSize, zoom: number) => Math.min(image.width, image.height) / zoom

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** The crop moved and zoomed back inside the image: zoom within 1…MAX_ZOOM, the square never past an edge. */
export function clampCrop(image: ImageSize, crop: Crop): Crop {
  const zoom = clamp(crop.zoom, 1, Math.min(MAX_ZOOM, Math.max(1, Math.min(image.width, image.height))))
  const half = cropSide(image, zoom) / 2
  return {
    zoom,
    cx: clamp(crop.cx, half, image.width - half),
    cy: clamp(crop.cy, half, image.height - half),
  }
}

/** The first frame: the largest square, in the middle of the image. */
export const defaultCrop = (image: ImageSize): Crop => ({ cx: image.width / 2, cy: image.height / 2, zoom: 1 })

/**
 * The crop after the image was dragged by `dx`, `dy` frame pixels in a frame of `frame` pixels: the picture follows
 * the pointer, so the kept square moves the other way.
 */
export function panCrop(image: ImageSize, crop: Crop, dx: number, dy: number, frame: number): Crop {
  const perFramePixel = cropSide(image, crop.zoom) / frame
  return clampCrop(image, { ...crop, cx: crop.cx - dx * perFramePixel, cy: crop.cy - dy * perFramePixel })
}

/**
 * The crop at `zoom`, keeping the image point under `at` (frame pixels from the frame's top left; default: the
 * middle) where it is, as a pinch or a wheel over that point expects.
 */
export function zoomCrop(
  image: ImageSize,
  crop: Crop,
  zoom: number,
  frame: number,
  at?: { x: number; y: number },
): Crop {
  const next = clampCrop(image, { ...crop, zoom }).zoom
  const point = at ?? { x: frame / 2, y: frame / 2 }
  const before = cropSide(image, crop.zoom) / frame
  const after = cropSide(image, next) / frame
  // The image point under `point` stays under it: centre + (point − middle) × pixels per frame pixel, before = after.
  const ox = point.x - frame / 2
  const oy = point.y - frame / 2
  return clampCrop(image, { zoom: next, cx: crop.cx + ox * (before - after), cy: crop.cy + oy * (before - after) })
}

/** Where the image is drawn in a frame of `frame` pixels: its left and top edge and its drawn width and height. */
export function imagePlacement(image: ImageSize, crop: Crop, frame: number) {
  const scale = frame / cropSide(image, crop.zoom)
  return {
    left: frame / 2 - crop.cx * scale,
    top: frame / 2 - crop.cy * scale,
    width: image.width * scale,
    height: image.height * scale,
  }
}

/**
 * What to copy from the image (source square) and how large the saved square is: at most `max` pixels, never larger
 * than the kept square itself (no blown-up blur), at least one pixel.
 */
export function cropOutput(image: ImageSize, crop: Crop, max: number) {
  const { cx, cy, zoom } = clampCrop(image, crop)
  const side = cropSide(image, zoom)
  return { sx: cx - side / 2, sy: cy - side / 2, side, out: Math.max(1, Math.min(max, Math.round(side))) }
}
