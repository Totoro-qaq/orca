/**
 * The workspace a forwarded SSH-host command may touch on this desktop. While a bridged command
 * runs, every workspace selector the browser layer resolves must name exactly that workspace; any
 * other selector is refused, so a host can never widen its reach to the desktop's own worktrees.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { BrowserError } from '../../browser/browser-error'
import { DESKTOP_BROWSER_BRIDGE_SCOPE_CODE } from '../../../shared/desktop-browser-bridge-protocol'

const scope = new AsyncLocalStorage<{ workspaceId: string }>()

export function runInRemoteCliBrowserScope<T>(
  workspaceId: string,
  run: () => Promise<T>
): Promise<T> {
  return scope.run({ workspaceId }, run)
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
