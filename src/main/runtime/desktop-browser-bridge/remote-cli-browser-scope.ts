/**
 * The workspace a forwarded SSH-host command may touch on this desktop. While a bridged command
 * runs, every workspace selector the browser layer resolves must name exactly that workspace; any
 * other selector is refused, so a host can never widen its reach to the desktop's own worktrees.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { BrowserError } from '../../browser/browser-error'
import {
  DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE
} from '../../../shared/desktop-browser-bridge-protocol'

const scope = new AsyncLocalStorage<{ workspaceId: string; revoked?: AbortSignal }>()

export function runInRemoteCliBrowserScope<T>(
  workspaceId: string,
  run: () => Promise<T>,
  revoked?: AbortSignal
): Promise<T> {
  return scope.run({ workspaceId, ...(revoked ? { revoked } : {}) }, run)
}

/**
 * Captured where a browser command is queued; the returned check throws once the bridge that
 * issued it detached, so a command waiting behind another never runs after access was revoked.
 */
export function captureRemoteCliBrowserRevocation(): () => void {
  const revoked = scope.getStore()?.revoked
  return () => {
    if (revoked?.aborted) {
      throw new BrowserError(
        DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
        'The Orca desktop stopped sharing its browser before this command ran.'
      )
    }
  }
}

/** Null outside a bridged command; inside one, the scoped workspace or a refusal. */
export function resolveRemoteCliBrowserScopeSelector(
  selector: string
): Promise<{ id: string }> | null {
  const active = scope.getStore()
  if (!active) {
    return null
  }
  if (selector === `id:${active.workspaceId}`) {
    return Promise.resolve({ id: active.workspaceId })
  }
  return Promise.reject(
    new BrowserError(
      DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
      'An SSH host can only reach browser tabs in its own workspaces.'
    )
  )
}
