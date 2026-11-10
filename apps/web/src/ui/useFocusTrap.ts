import { useEffect, type RefObject } from 'react'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * While active, keeps Tab inside the container, moves focus into it and gives focus back to
 * where it was when it ends. For dialogs and the slide-in navigation.
 */
export function useFocusTrap(container: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const root = container.current
    if (!active || !root) return
    const previous = document.activeElement as HTMLElement | null
    const focusable = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
    if (!root.contains(document.activeElement)) focusable()[0]?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      const items = focusable()
      const first = items[0], last = items.at(-1)
      if (!first || !last) return e.preventDefault()
      const at = document.activeElement
      if (e.shiftKey && (at === first || !root!.contains(at))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (at === last || !root!.contains(at))) { e.preventDefault(); first.focus() }
    }
    root.addEventListener('keydown', onKeyDown)
    return () => {
      root.removeEventListener('keydown', onKeyDown)
      if (previous?.isConnected) previous.focus()
    }
  }, [container, active])
}
