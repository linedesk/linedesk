// The keys of every setup page (onboarding, step by step, the install by hand, the agent setup, the partner setup, a
// Checkout's result): Enter runs the page's main action (its button shows ⏎), Esc goes back. One rule set for all of
// them, so a key never means one thing on one setup page and another on the next.
import { useEffect, useRef } from 'react'

export type SetupKeys = {
  /** The page's main action; none: Enter does nothing here. */
  onEnter?: (() => void) | null
  /** Back; none: Esc does nothing here (Shift+Esc stays the top bar's Finish later or Close). */
  onEscape?: (() => void) | null
}

export type SetupKeyOptions = {
  /**
   * `continue` (default): Enter in a one-line field runs the main action (a step whose field is its question). `ignore`:
   * nothing while a field has the focus (a page whose fields belong to their own small forms).
   */
  fields?: 'continue' | 'ignore'
}

/** A modal dialog over the page takes its own keys (a provider's key, ⌘K, the shortcut sheet). */
const MODAL = '[role="dialog"][aria-modal="true"], [role="alertdialog"], dialog[open]'
const FIELD = 'input, textarea, select, [contenteditable="true"]'

/**
 * Whether Enter or Esc (`key`) on `target` belongs to the page, by the shared rules: never while a modal dialog is open
 * or inside a form (it submits itself); Enter never on a button, link or summary (they take it), in a text area only
 * with ⌘/Ctrl, and not with Shift or Alt; Esc never with a modifier.
 */
export function setupKeyFor(
  e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'isComposing' | 'defaultPrevented'>,
  target: Element | null,
  fields: 'continue' | 'ignore',
  root: Pick<Document, 'querySelector'> = document,
): 'enter' | 'escape' | null {
  if (e.isComposing || e.defaultPrevented) return null
  if (e.key !== 'Enter' && e.key !== 'Escape') return null
  if (root.querySelector(MODAL)) return null
  if (target?.closest('form')) return null
  const inField = !!target?.matches(FIELD)
  if (fields === 'ignore' && inField) return null
  if (e.key === 'Escape') return e.shiftKey || e.metaKey || e.ctrlKey || e.altKey ? null : 'escape'
  if (e.shiftKey || e.altKey) return null
  if (target?.matches('button, a, summary')) return null
  const textArea = target?.matches('textarea') ?? false
  if (textArea !== (e.metaKey || e.ctrlKey)) return null
  return 'enter'
}

export function useSetupKeys(keys: SetupKeys, { fields = 'continue' }: SetupKeyOptions = {}) {
  const ref = useRef({ keys, fields })
  ref.current = { keys, fields }
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const { keys, fields } = ref.current
      const key = setupKeyFor(e, e.target instanceof Element ? e.target : null, fields)
      const run = key === 'enter' ? keys.onEnter : key === 'escape' ? keys.onEscape : null
      if (!run) return
      e.preventDefault()
      run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
