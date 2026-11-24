import { describe, expect, test } from 'vitest'
import { IMAGE_ACCEPT, pngDataUrlBytes, squareFit } from './imageAsPng.ts'

describe('squareFit', () => {
  test('a wide image is scaled down to fit the square and centred vertically', () => {
    expect(squareFit(1024, 512, 512)).toEqual({ side: 512, x: 0, y: 128, width: 512, height: 256 })
  })
  test('a tall image is centred horizontally', () => {
    expect(squareFit(100, 400, 512)).toEqual({ side: 400, x: 150, y: 0, width: 100, height: 400 })
  })
  test('a small image keeps its size; an SVG without a size fills the square', () => {
    expect(squareFit(64, 64, 512)).toEqual({ side: 64, x: 0, y: 0, width: 64, height: 64 })
    expect(squareFit(0, 0, 512)).toEqual({ side: 512, x: 0, y: 0, width: 512, height: 512 })
  })
})

test('pngDataUrlBytes counts the bytes of the image, not the base64 text', () => {
  const of = (bytes: number) => `data:image/png;base64,${Buffer.alloc(bytes).toString('base64')}`
  for (const n of [0, 1, 2, 3, 4, 1000, 512 * 1024]) expect(pngDataUrlBytes(of(n))).toBe(n)
})

test('the upload field offers PNG, JPEG, WebP and SVG', () => {
  expect(IMAGE_ACCEPT.split(',')).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])
})
