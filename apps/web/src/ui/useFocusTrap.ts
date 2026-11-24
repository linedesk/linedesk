import { useEffect, type RefObject } from 'react'

/** Controls Tab reaches; `tabindex="-1"` ones (the backdrop's close target) are left out, so focus lands in the panel. */
const FOCUSABLE =
  ':is(a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]):not([tabindex="-1"])'

/**
 * While active, keeps Tab inside the container, moves focus into it and gives focus back to
 * where it was when it ends. For dialogs and the slide-in navigation.
 */
type Options = {
  /** Where focus goes when the trap starts (else the first control). */
  initial?: string
  /** Where focus returns when it ends. Taken at render time by the caller: an autofocused field inside has moved it by the time effects run. */
  restoreTo?: HTMLElement | null
}

export function useFocusTrap(
  container: RefObject<HTMLElement | null>,
  active: boolean,
  { initial, restoreTo }: Options = {},
) {
  useEffect(() => {
    const root = container.current
    if (!active || !root) return
    const previous = restoreTo !== undefined ? restoreTo : (document.activeElement as HTMLElement | null)
    const focusable = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (!root.contains(document.activeElement))
      ((initial && root.querySelector<HTMLElement>(initial)) || focusable()[0])?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      const items = focusable()
      const first = items[0],
        last = items.at(-1)
      if (!first || !last) return e.preventDefault()
      const at = document.activeElement
      if (e.shiftKey && (at === first || !root!.contains(at))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (at === last || !root!.contains(at))) {
        e.preventDefault()
        first.focus()
      }
    }
    root.addEventListener('keydown', onKeyDown)
    return () => {
      root.removeEventListener('keydown', onKeyDown)
      if (previous?.isConnected) previous.focus()
    }
  }, [container, active, initial, restoreTo])
}
