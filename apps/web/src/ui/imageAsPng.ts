// Any image the browser can show (PNG, JPEG, WebP, SVG), drawn centred on a transparent square and saved as a PNG,
// for images people upload that the server stores (the install logo in Server admin › Branding does the same; the
// profile picture and the workspace icon go through the crop step, ImageCrop.tsx, and its PNG through `canvasAsPng`).
// Drawing to a canvas keeps only pixels: an SVG never reaches the server, so no script in one is ever served.

/** The file types the upload fields offer. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml'

const PNG_PREFIX = 'data:image/png;base64,'

/** Where an image of `width`×`height` goes on a square of at most `max` pixels: scaled down to fit, centred. */
export function squareFit(width: number, height: number, max: number) {
  const w = width || max
  const h = height || max
  const side = Math.min(max, Math.max(w, h))
  const scale = side / Math.max(w, h)
  return { side, x: (side - w * scale) / 2, y: (side - h * scale) / 2, width: w * scale, height: h * scale }
}

/** The bytes a PNG data URL holds (base64 without padding counted). */
export const pngDataUrlBytes = (dataUrl: string) =>
  Math.floor(((dataUrl.length - PNG_PREFIX.length) * 3) / 4) -
  (dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0)

/** Loads `file` as an image the page can draw. Throws an Error that says what to do when the browser can't read it. */
export async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode().catch(() => {
      throw new Error('That file is not an image this browser can read. Use a PNG, JPEG, WebP or SVG.')
    })
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The canvas as a PNG data URL; throws an Error when it is larger than `maxBytes`. `what`: "The icon", "The picture". */
export function canvasAsPng(canvas: HTMLCanvasElement, { maxBytes, what }: { maxBytes: number; what: string }) {
  const png = canvas.toDataURL('image/png')
  if (pngDataUrlBytes(png) > maxBytes)
    throw new Error(`${what} is too large once converted: use a simpler image (at most ${maxBytes / 1024} KB).`)
  return png
}

/**
 * The image in `file` as a PNG data URL of at most `size`×`size` pixels and `maxBytes`. Throws an Error that says
 * what to do when the browser cannot read it or the PNG is too large. `what`: "The icon", "The logo".
 */
export async function imageAsPng(
  file: File,
  { size, maxBytes, what }: { size: number; maxBytes: number; what: string },
) {
  const image = await loadImage(file)
  const fit = squareFit(image.naturalWidth, image.naturalHeight, size)
  const canvas = document.createElement('canvas')
  canvas.width = fit.side
  canvas.height = fit.side
  canvas.getContext('2d')!.drawImage(image, fit.x, fit.y, fit.width, fit.height)
  return canvasAsPng(canvas, { maxBytes, what })
}
