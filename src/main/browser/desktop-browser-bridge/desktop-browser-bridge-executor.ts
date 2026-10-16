/**
 * Runs one browser command a managed SSH host forwarded, on this desktop, inside that host's scope:
 * an allowlisted method, against a workspace this desktop shows as the host's own, with every
 * workspace selector pinned to it. Every outcome is audit-logged; params are not, since they can
 * carry typed secrets.
 */
import {
  DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE,
  DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
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
  /** True only when this desktop shows `workspaceId` as owned by the environment's own machine. */
  authorizeWorkspace(workspaceId: string): Promise<boolean>
  worktreeIdForPage(browserPageId: string): string | null
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
  deps: DesktopBrowserBridgeExecutorDeps
): Promise<DesktopBrowserBridgeOutcome> {
  const audit = {
    environmentId: deps.environmentId,
    hostLabel: deps.hostLabel,
    method: request.method,
    workspaceId: null as string | null,
    page: null as string | null,
    urlOrigin: urlOrigin(request.params.url)
  }
  try {
    const { params, workspaceId, page } = await scopeRequest(request, deps)
    audit.workspaceId = workspaceId
    audit.page = page
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
  let workspaceId = request.workspaceId ?? null
  if (params.worktree !== undefined && (!workspaceId || params.worktree !== `id:${workspaceId}`)) {
    throw outOfScope()
  }
  const page = typeof params.page === 'string' && params.page.length > 0 ? params.page : null
  if (page) {
    const pageWorkspaceId = deps.worktreeIdForPage(page)
    if (!pageWorkspaceId || (workspaceId && pageWorkspaceId !== workspaceId)) {
      throw new BridgeRefusal('browser_tab_not_found', `Browser page ${page} was not found`)
    }
    workspaceId = pageWorkspaceId
  }
  if (!workspaceId) {
    throw new BridgeRefusal(
      DESKTOP_BROWSER_BRIDGE_SCOPE_CODE,
      'Run this command inside a workspace on this host, or pass --worktree, so Orca knows which workspace’s browser tabs it may use.'
    )
  }
  if (!(await deps.authorizeWorkspace(workspaceId))) {
    // Why the same refusal for a foreign page: an unknown and a forbidden page must look alike.
    throw page
      ? new BridgeRefusal('browser_tab_not_found', `Browser page ${page} was not found`)
      : outOfScope()
  }
  params.worktree = `id:${workspaceId}`
  return { params, workspaceId, page }
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
