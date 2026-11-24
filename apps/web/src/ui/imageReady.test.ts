import { afterEach, describe, expect, test } from 'vitest'
import { type ImageLoader, imageState, onImageSettled, preloadImage, resetImageStates } from './imageReady.ts'

/** A stand-in <img>: records what it was asked to load; the test says when it loaded or failed. */
function fakeLoader() {
  const made: ImageLoader[] = []
  const make = () => {
    const img: ImageLoader = { onload: null, onerror: null, src: '' }
    made.push(img)
    return img
  }
  return { made, make }
}

afterEach(resetImageStates)

describe('preloadImage', () => {
  test('asks for the picture once, however often it is asked', () => {
    const { made, make } = fakeLoader()
    expect(preloadImage('/v1/avatars/u1.png?v=a', make)).toBe('loading')
    expect(preloadImage('/v1/avatars/u1.png?v=a', make)).toBe('loading')
    expect(made.map(i => i.src)).toEqual(['/v1/avatars/u1.png?v=a'])
  })

  test('says when it loaded, and tells who waits for it', () => {
    const { made, make } = fakeLoader()
    preloadImage('/v1/avatars/u1.png?v=a', make)
    let told = 0
    const stop = onImageSettled('/v1/avatars/u1.png?v=a', () => told++)
    made[0]!.onload!(new Event('load'))
    expect(told).toBe(1)
    expect(imageState('/v1/avatars/u1.png?v=a')).toBe('ready')
    expect(preloadImage('/v1/avatars/u1.png?v=a', make)).toBe('ready')
    stop()
  })

  test('a picture that fails says so; a new version is asked for afresh', () => {
    const { made, make } = fakeLoader()
    preloadImage('/v1/avatars/u1.png?v=a', make)
    made[0]!.onerror!(new Event('error'))
    expect(imageState('/v1/avatars/u1.png?v=a')).toBe('failed')
    expect(preloadImage('/v1/avatars/u1.png?v=b', make)).toBe('loading')
    expect(made).toHaveLength(2)
  })

  test('no picture is nothing to wait for', () => {
    expect(imageState(null)).toBe('none')
  })
})
