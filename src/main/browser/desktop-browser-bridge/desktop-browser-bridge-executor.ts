/**
 * Runs one browser command a managed SSH host forwarded, on this desktop, inside that host's scope:
 * an allowlisted method, against a workspace this desktop shows as the host's own, with every
 * workspace selector pinned to it. Every outcome is audit-logged; params are not, since they can
 * carry typed secrets.
 */
import {
  DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
  DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
  DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
  isDesktopBrowserBridgeMethod,
  type DesktopBrowserBridgeRequest
} from '../../../shared/desktop-browser-bridge-protocol'
import type { RpcResponse } from '../../runtime/rpc/core'
import { runInRemoteCliBrowserScope } from '../../runtime/desktop-browser-bridge/remote-cli-browser-scope'

export type DesktopBrowserBridgeOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }

export type DesktopBrowserBridgeAuditEntry = {
  environmentId: string
  hostLabel: string
  method: string
  workspaceId: string | null
  page: string | null
  urlOrigin: string | null
  outcome: 'ok' | 'refused' | 'failed'
  code?: string
}

export type DesktopBrowserBridgeExecutorDeps = {
  environmentId: string
  hostLabel: string
  /**
   * The workspace this desktop shows as owned by the environment's own machine for the named page
   * and/or workspace, or null. A page that has not mounted yet is known only to the renderer.
   */
  resolveWorkspace(scope: {
    workspaceId: string | null
    page: string | null
  }): Promise<string | null>
  /** The workspace a mounted page registered under, if it has mounted. */
  worktreeIdForPage(browserPageId: string): string | null
  /** Records that a host drives this workspace's pages, so they lose programmatic clipboard reads. */
  markWorkspaceDriven(workspaceId: string): void
  dispatch(method: string, params: Record<string, unknown>): Promise<RpcResponse>
  audit(entry: DesktopBrowserBridgeAuditEntry): void
}

// Why: a host may not pick the desktop page id, tab group, focus or browser profile of a new tab.
const TAB_CREATE_STRIPPED_PARAMS = [
  'page',
  'profileId',
  'placement',
  'targetGroupId',
  'activate',
  'navigation'
] as const

class BridgeRefusal extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export async function executeDesktopBrowserBridgeRequest(
  request: DesktopBrowserBridgeRequest,
  deps: DesktopBrowserBridgeExecutorDeps,
  /** Aborted when the bridge detaches; a command not yet dispatched must then never run. */
  signal?: AbortSignal
): Promise<DesktopBrowserBridgeOutcome> {
  const audit: Omit<DesktopBrowserBridgeAuditEntry, 'outcome' | 'code'> = {
    environmentId: deps.environmentId,
    hostLabel: deps.hostLabel,
    method: request.method,
    workspaceId: null,
    page: null,
    urlOrigin: urlOrigin(request.params.url)
  }
  try {
    const { params, workspaceId, page } = await scopeRequest(request, deps)
    audit.workspaceId = workspaceId
    audit.page = page
    if (signal?.aborted) {
      throw new BridgeRefusal(
        DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE,
        'The Orca desktop stopped sharing its browser before this command ran.'
      )
    }
    deps.markWorkspaceDriven(workspaceId)
    const response = await runInRemoteCliBrowserScope(workspaceId, () =>
      deps.dispatch(request.method, params)
    )
    if (!response.ok) {
      deps.audit({ ...audit, outcome: 'failed', code: response.error.code })
      return { ok: false, error: { code: response.error.code, message: response.error.message } }
    }
    deps.audit({ ...audit, outcome: 'ok' })
    return { ok: true, result: response.result }
  } catch (error) {
    if (error instanceof BridgeRefusal) {
      deps.audit({ ...audit, outcome: 'refused', code: error.code })
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    const message = error instanceof Error ? error.message : String(error)
    deps.audit({ ...audit, outcome: 'failed', code: 'runtime_error' })
    return { ok: false, error: { code: 'runtime_error', message } }
  }
}

async function scopeRequest(
  request: DesktopBrowserBridgeRequest,
  deps: DesktopBrowserBridgeExecutorDeps
): Promise<{ params: Record<string, unknown>; workspaceId: string; page: string | null }> {
  // Why again here: the desktop is the trust boundary, never what the host claims it checked.
  if (!isDesktopBrowserBridgeMethod(request.method)) {
    throw new BridgeRefusal(
      DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
      `${request.method} cannot run on this desktop from an SSH host.`
    )
  }
  const params: Record<string, unknown> = { ...request.params }
  if (request.method === 'browser.tabCreate') {
    for (const key of TAB_CREATE_STRIPPED_PARAMS) {
      delete params[key]
    }
  }
  if (
    (request.method === 'browser.goto' || request.method === 'browser.tabCreate') &&
    !isWebNavigationUrl(params.url, request.method === 'browser.tabCreate')
  ) {
    // Why: a bare path normalizes to file:// and loadURL skips the guest navigation guard.
    throw new BridgeRefusal(
      'invalid_argument',
      'An SSH host can open only http:// or https:// URLs in the desktop browser. Pass the full URL.'
    )
  }
  if (request.method === 'browser.keypress' && isPasteChord(params.key)) {
    throw new BridgeRefusal(
      DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
      'An SSH host cannot paste from the desktop clipboard. Use orca type or orca fill instead.'
    )
  }
  const requestedWorkspaceId = request.workspaceId ?? null
  if (
    params.worktree !== undefined &&
    (!requestedWorkspaceId || params.worktree !== `id:${requestedWorkspaceId}`)
  ) {
    throw outOfScope()
  }
  const page = typeof params.page === 'string' && params.page.length > 0 ? params.page : null
  if (!requestedWorkspaceId && !page) {
    throw new BridgeRefusal(
      DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
      'Run this command inside a workspace on this host, or pass --worktree, so Orca knows which workspace’s browser tabs it may use.'
    )
  }
  const workspaceId = await deps.resolveWorkspace({ workspaceId: requestedWorkspaceId, page })
  const mountedWorkspaceId = page ? deps.worktreeIdForPage(page) : null
  if (!workspaceId || (mountedWorkspaceId && mountedWorkspaceId !== workspaceId)) {
    // Why the same refusal for a foreign page: an unknown and a forbidden page must look alike.
    throw page
      ? new BridgeRefusal('browser_tab_not_found', `Browser page ${page} was not found`)
      : outOfScope()
  }
  params.worktree = `id:${workspaceId}`
  return { params, workspaceId, page }
}

function isWebNavigationUrl(value: unknown, optional: boolean): boolean {
  if (value === undefined && optional) {
    return true
  }
  if (typeof value !== 'string') {
    return false
  }
  if (value === 'about:blank') {
    return true
  }
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

const PASTE_MODIFIERS = new Set(['control', 'ctrl', 'meta', 'cmd', 'command', 'super'])

function isPasteChord(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false
  }
  const parts = value
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
  const key = parts.at(-1)
  const modifiers = parts.slice(0, -1)
  return (
    (key === 'v' && modifiers.some((modifier) => PASTE_MODIFIERS.has(modifier))) ||
    (key === 'insert' && modifiers.includes('shift'))
  )
}

function outOfScope(): BridgeRefusal {
  return new BridgeRefusal(
    DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
    'An SSH host can only reach browser tabs in its own workspaces.'
  )
}

function urlOrigin(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}
