// Quiet toasts, plus the "Next time, press E" tip after an action was triggered with the mouse.
import { useCallback, useEffect, useRef, useState } from 'react'
import { i18n } from '../i18n/index.tsx'
import { HINT_EVENT, type ShortcutHint } from '../ui/tooltips.ts'

export type ToastState = { text: string; undo: boolean }
/** How the current action was triggered: a shortcut, ⌘K + Enter, or the mouse. */
export type Source = 'key' | 'menu-key' | 'mouse'

/** "Archived · Next time, press E", or the tip alone when there is no label. */
const shortcutTip = (label: string | undefined, key: string) =>
  label ? i18n().t('shell.shortcutTip.withLabel', { label, key }) : i18n().t('shell.shortcutTip.alone', { key })

/** A touch screen without a mouse (a phone): no "Next time, press M", there is usually no keyboard to press it on. */
const touchOnly = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(hover: none) and (pointer: coarse)').matches

const PLAIN_MS = 2600
const UNDO_MS = 5000

export function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const lastShownAt = useRef(0)
  const source = useRef<Source>('mouse')

  /** `ms`: how long it stays; by default 2.6 s, 5 s with Undo. */
  const show = useCallback((text: string, undo = false, ms?: number) => {
    lastShownAt.current = Date.now()
    setToast({ text, undo })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), ms ?? (undo ? UNDO_MS : PLAIN_MS))
  }, [])

  /** Run `fn` as triggered by `src`; tips inside it follow that source. */
  const via = useCallback(<T>(src: Source, fn: () => T): T => {
    const previous = source.current
    source.current = src
    try {
      return fn()
    } finally {
      source.current = previous
    }
  }, [])

  const withTip = useCallback(
    (label: string, key: string) => (source.current === 'mouse' && !touchOnly() ? shortcutTip(label, key) : label),
    [],
  )

  // A click on a control with a shortcut that produced no toast of its own still gets the tip.
  useEffect(() => {
    function onHint(e: Event) {
      if (touchOnly()) return
      const { label, keys } = (e as CustomEvent<ShortcutHint>).detail
      setTimeout(() => {
        if (Date.now() - lastShownAt.current > 80)
          show(shortcutTip(label, keys.join(' ')))
      }, 30)
    }
    window.addEventListener(HINT_EVENT, onHint)
    return () => window.removeEventListener(HINT_EVENT, onHint)
  }, [show])

  return { toast, show, via, withTip, currentSource: () => source.current }
}
export type Toaster = ReturnType<typeof useToast>
