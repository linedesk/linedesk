// Leaving the install walkthrough ("Set up later", "Set up your business"): the page moves on at once and where the
// admin left it is saved meanwhile. A slow or stuck server must not hold the button: a save that never answers made
// both buttons look dead, and every further click queued one more save (LIN-227).

/** Starts the save, then leaves without waiting for it; the save handles its own failure. */
export function leaveInstallSetup<C>(save: (change: C) => Promise<unknown>, change: C, onExit: () => void): void {
  void save(change)
  onExit()
}
