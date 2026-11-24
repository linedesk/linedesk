// A picture asked for before it is shown (the you-row of the workspace menu): the request starts when the page
// mounts, not when the menu opens, so the picture is in the browser's cache (its address is versioned and cached
// for good) by the time anyone looks. What became of each address is kept for the page's life.
import { useEffect, useSyncExternalStore } from 'react'

export type ImageState = 'none' | 'loading' | 'ready' | 'failed'

/** Just what a preload needs of an <img>: `new Image()` in the browser, a stand-in in tests. */
export type ImageLoader = {
  onload: ((ev: Event) => unknown) | null
  onerror: ((ev: Event) => unknown) | null
  src: string
}

const states = new Map<string, Exclude<ImageState, 'none'>>()
const listeners = new Map<string, Set<() => void>>()

/** What became of `src` so far: `loading` until it loaded or failed (also before anyone asked for it). */
export const imageState = (src: string | null): ImageState => (src ? (states.get(src) ?? 'loading') : 'none')

/** Starts loading `src` once per page; later calls only say how far it got. */
export function preloadImage(src: string, make: () => ImageLoader = () => new Image()): ImageState {
  const known = states.get(src)
  if (known) return known
  states.set(src, 'loading')
  const img = make()
  const settle = (state: 'ready' | 'failed') => {
    states.set(src, state)
    for (const listener of listeners.get(src) ?? []) listener()
  }
  img.onload = () => settle('ready')
  img.onerror = () => settle('failed')
  img.src = src
  return 'loading'
}

/** Calls `listener` when `src` loads or fails; returns the unsubscribe. */
export function onImageSettled(src: string, listener: () => void): () => void {
  const set = listeners.get(src) ?? new Set()
  set.add(listener)
  listeners.set(src, set)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(src)
  }
}

/** Forgets every address (tests). */
export function resetImageStates() {
  states.clear()
  listeners.clear()
}

/** Loads `src` now and follows it: `none` without a picture, then `loading`, `ready` or `failed`. */
export function useImageReady(src: string | null): ImageState {
  useEffect(() => {
    if (src) preloadImage(src)
  }, [src])
  return useSyncExternalStore(
    listener => (src ? onImageSettled(src, listener) : () => {}),
    () => imageState(src),
    () => imageState(src),
  )
}
