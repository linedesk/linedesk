// A small dropdown in the navigation (the workspace menu at the top, the profile menu at the bottom): a
// button opens it, the first item takes focus, arrows move, Esc or Tab closes it and gives focus back
// to the button, a click outside closes it, and it never outlives the navigation.
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

const ITEMS = '[role^="menuitem"]'

/** `navOpen`: the navigation is on screen; `onOpen`: runs each time the menu opens (refresh what it lists). */
export function useMenu(navOpen: boolean, onOpen?: () => void) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const opened = useRef(onOpen)
  opened.current = onOpen
  useEffect(() => {
    if (!navOpen) setOpen(false)
  }, [navOpen])

  useEffect(() => {
    if (!open) return
    opened.current?.()
    root.current?.querySelector<HTMLElement>(ITEMS)?.focus()
    const onMouseDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  function onKeyDown(e: KeyboardEvent) {
    e.stopPropagation() // the menu has the keyboard while it is open
    const all = [...(root.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])]
    const at = all.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false) // Tab then moves on from the button
      trigger.current?.focus()
    } else if (e.defaultPrevented) {
      // an item handled the key itself (the workspace filter moves into the list)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      all[(at + 1) % all.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      all[(at - 1 + all.length) % all.length]?.focus()
    }
  }

  /** Arrow down on the closed button opens the menu, like a click. */
  function onTriggerKeyDown(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' || open) return
    e.preventDefault()
    e.stopPropagation() // not also the inbox's next row
    setOpen(true)
  }

  /** Close the menu, then do what the item does. */
  const choose = (run: () => void) => () => {
    setOpen(false)
    run()
  }

  return { open, setOpen, root, trigger, onKeyDown, onTriggerKeyDown, choose }
}
