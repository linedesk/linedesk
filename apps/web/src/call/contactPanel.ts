// I opens or closes the contact panel of the open call. The call view registers its toggle while it
// is shown (like the recording player), so the app's key handler does not need the view's state.
let toggleMounted: (() => void) | null = null

/** The mounted call view registers its toggle here; returns how to unregister. */
export function registerContactPanel(toggle: () => void): () => void {
  toggleMounted = toggle
  return () => {
    if (toggleMounted === toggle) toggleMounted = null
  }
}

/** Toggles the panel; false when no call view is shown. */
export function toggleContactPanel(): boolean {
  toggleMounted?.()
  return toggleMounted !== null
}
