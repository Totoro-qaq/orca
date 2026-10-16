/** A dependency-free hook so SSH state and settings paths can ask the bridge to re-check its hosts. */
let reconcile: (() => void) | null = null

export function setDesktopBrowserBridgeReconciler(next: (() => void) | null): void {
  reconcile = next
}

export function requestDesktopBrowserBridgeReconcile(): void {
  try {
    reconcile?.()
  } catch (error) {
    console.warn('[desktop-browser-bridge] reconcile failed:', error)
  }
}
