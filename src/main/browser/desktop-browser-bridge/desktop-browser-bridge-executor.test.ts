import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_BROWSER_BRIDGE_METHODS,
  type DesktopBrowserBridgeRequest
} from '../../../shared/desktop-browser-bridge-protocol'
import { resolveRemoteCliBrowserScopeSelector } from '../../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import {
  executeDesktopBrowserBridgeRequest,
  type DesktopBrowserBridgeAuditEntry,
  type DesktopBrowserBridgeExecutorDeps
} from './desktop-browser-bridge-executor'

const HOST_WORKSPACE = 'repo-host::/srv/app'
const LOCAL_WORKSPACE = 'repo-local::/Users/me/app'
// What the renderer knows: every page record, mounted or not.
const PAGE_OWNERS: Record<string, string> = {
  'host-page': HOST_WORKSPACE,
  'unmounted-host-page': HOST_WORKSPACE,
  'local-page': LOCAL_WORKSPACE
}
// What main's browser registry knows: only pages whose webview has mounted.
const MOUNTED_PAGE_OWNERS: Record<string, string> = {
  'host-page': HOST_WORKSPACE,
  'local-page': LOCAL_WORKSPACE
}

/** The renderer's answer: the page's or named workspace, if this host owns it. */
async function rendererScope(scope: {
  workspaceId: string | null
  page: string | null
}): Promise<string | null> {
  const pageWorkspace = scope.page ? (PAGE_OWNERS[scope.page] ?? null) : null
  if (scope.page && !pageWorkspace) {
    return null
  }
  if (scope.workspaceId && pageWorkspace && scope.workspaceId !== pageWorkspace) {
    return null
  }
  const workspaceId = pageWorkspace ?? scope.workspaceId
  return workspaceId === HOST_WORKSPACE ? workspaceId : null
}

function request(overrides: Partial<DesktopBrowserBridgeRequest>): DesktopBrowserBridgeRequest {
  return {
    type: 'request',
    requestId: 'r1',
    method: 'browser.snapshot',
    params: {},
    ...overrides
  }
}

function deps(overrides: Partial<DesktopBrowserBridgeExecutorDeps> = {}) {
  const audit: DesktopBrowserBridgeAuditEntry[] = []
  const dispatched: { method: string; params: Record<string, unknown>; scopeProbe: unknown }[] = []
  const value: DesktopBrowserBridgeExecutorDeps = {
    environmentId: 'env-host',
    hostLabel: 'sandbox',
    resolveWorkspace: rendererScope,
    worktreeIdForPage: (page) => MOUNTED_PAGE_OWNERS[page] ?? null,
    dispatch: async (method, params) => {
      // Inside the dispatch, a selector for any other workspace must be refused.
      const scopeProbe = await resolveRemoteCliBrowserScopeSelector(`id:${LOCAL_WORKSPACE}`)?.catch(
        (error: Error) => error.message
      )
      dispatched.push({ method, params, scopeProbe })
      return { id: 'x', ok: true, result: { done: true }, _meta: { runtimeId: 'desktop' } }
    },
    audit: (entry) => audit.push(entry),
    ...overrides
  }
  return { value, audit, dispatched }
}

describe('executeDesktopBrowserBridgeRequest', () => {
  it('runs an allowlisted command pinned to the host workspace and audits it', async () => {
    const { value, audit, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({
        method: 'browser.goto',
        workspaceId: HOST_WORKSPACE,
        params: { url: 'https://example.com/path?token=secret', worktree: `id:${HOST_WORKSPACE}` }
      }),
      value
    )

    expect(outcome).toEqual({ ok: true, result: { done: true } })
    expect(dispatched).toEqual([
      {
        method: 'browser.goto',
        params: { url: 'https://example.com/path?token=secret', worktree: `id:${HOST_WORKSPACE}` },
        scopeProbe: 'An SSH host can only reach browser tabs in its own workspaces.'
      }
    ])
    // The audit names the origin only: query strings can carry credentials.
    expect(audit).toEqual([
      expect.objectContaining({
        method: 'browser.goto',
        workspaceId: HOST_WORKSPACE,
        urlOrigin: 'https://example.com',
        outcome: 'ok'
      })
    ])
    expect(JSON.stringify(audit)).not.toContain('secret')
  })

  it('refuses a workspace this desktop does not show as the host’s own', async () => {
    const { value, audit, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: LOCAL_WORKSPACE, params: { worktree: `id:${LOCAL_WORKSPACE}` } }),
      value
    )

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_out_of_scope' }
    })
    expect(dispatched).toEqual([])
    expect(audit[0]).toMatchObject({ outcome: 'refused' })
  })

  it('refuses a page in another workspace as if it did not exist', async () => {
    const { value, dispatched } = deps()

    const pageOnly = await executeDesktopBrowserBridgeRequest(
      request({ params: { page: 'local-page' } }),
      value
    )
    const crossWorkspace = await executeDesktopBrowserBridgeRequest(
      request({
        workspaceId: HOST_WORKSPACE,
        params: { page: 'local-page', worktree: `id:${HOST_WORKSPACE}` }
      }),
      value
    )

    expect(pageOnly).toMatchObject({ ok: false, error: { code: 'browser_tab_not_found' } })
    expect(crossWorkspace).toMatchObject({ ok: false, error: { code: 'browser_tab_not_found' } })
    expect(dispatched).toEqual([])
  })

  it('scopes a page-only command to the page’s workspace once that is authorized', async () => {
    const { value, dispatched } = deps()

    await executeDesktopBrowserBridgeRequest(
      request({ method: 'browser.click', params: { page: 'host-page', element: 'e1' } }),
      value
    )

    expect(dispatched[0]?.params).toEqual({
      page: 'host-page',
      element: 'e1',
      worktree: `id:${HOST_WORKSPACE}`
    })
  })

  it('refuses a command that names no workspace rather than widening to every tab', async () => {
    const { value, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(request({ params: {} }), value)

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_out_of_scope' }
    })
    expect(dispatched).toEqual([])
  })

  it('refuses a worktree param that disagrees with the resolved workspace', async () => {
    const { value, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: HOST_WORKSPACE, params: { worktree: `id:${LOCAL_WORKSPACE}` } }),
      value
    )

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_out_of_scope' }
    })
    expect(dispatched).toEqual([])
  })

  it.each([
    'browser.cookie.get',
    'browser.cookie.set',
    'browser.upload',
    'browser.download',
    'browser.pdf',
    'browser.exec',
    'browser.clipboardRead',
    'browser.clipboardWrite',
    'browser.profileImportFromBrowser',
    'browser.tabSetProfile',
    'browser.certificate.proceed',
    'browser.storage.local.get',
    'browser.setCredentials',
    'browser.clientHost.attach',
    'terminal.send',
    'files.read'
  ])('refuses %s even when a host sends it', async (method) => {
    expect(DESKTOP_BROWSER_BRIDGE_METHODS.has(method)).toBe(false)
    const { value, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({
        method,
        workspaceId: HOST_WORKSPACE,
        params: { worktree: `id:${HOST_WORKSPACE}` }
      }),
      value
    )

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_not_forwarded' }
    })
    expect(dispatched).toEqual([])
  })

  it('creates a tab only with the host’s url and workspace, never its profile, group, page id or focus', async () => {
    const { value, dispatched } = deps()

    await executeDesktopBrowserBridgeRequest(
      request({
        method: 'browser.tabCreate',
        workspaceId: HOST_WORKSPACE,
        params: {
          url: 'https://example.com',
          worktree: `id:${HOST_WORKSPACE}`,
          page: 'local-page',
          profileId: 'work-profile',
          targetGroupId: 'local-group',
          activate: true,
          navigation: 'caller',
          placement: { kind: 'client', browserHostClientId: 'x' }
        }
      }),
      value
    )

    expect(dispatched[0]?.params).toEqual({
      url: 'https://example.com',
      worktree: `id:${HOST_WORKSPACE}`
    })
  })

  it('returns the desktop’s own error unchanged and audits the failure', async () => {
    const { value, audit } = deps({
      dispatch: async () => ({
        id: 'x',
        ok: false,
        error: { code: 'browser_no_tab', message: 'No browser tab open in this worktree' },
        _meta: { runtimeId: 'desktop' }
      })
    })

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: HOST_WORKSPACE, params: { worktree: `id:${HOST_WORKSPACE}` } }),
      value
    )

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'browser_no_tab', message: 'No browser tab open in this worktree' }
    })
    expect(audit[0]).toMatchObject({ outcome: 'failed', code: 'browser_no_tab' })
  })

  it('treats a renderer that cannot answer as a refusal', async () => {
    const resolveWorkspace = vi.fn(async () => null)
    const { value, dispatched } = deps({ resolveWorkspace })

    await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: HOST_WORKSPACE, params: { worktree: `id:${HOST_WORKSPACE}` } }),
      value
    )

    expect(resolveWorkspace).toHaveBeenCalledWith({ workspaceId: HOST_WORKSPACE, page: null })
    expect(dispatched).toEqual([])
  })

  it('drives a host page the renderer knows before its webview has mounted', async () => {
    const { value, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({
        method: 'browser.goto',
        params: { page: 'unmounted-host-page', url: 'https://a.test' }
      }),
      value
    )

    expect(outcome).toEqual({ ok: true, result: { done: true } })
    expect(dispatched[0]?.params).toEqual({
      page: 'unmounted-host-page',
      url: 'https://a.test',
      worktree: `id:${HOST_WORKSPACE}`
    })
  })

  it('refuses a page whose mounted webview registered under another workspace', async () => {
    const { value, dispatched } = deps({
      worktreeIdForPage: (page) => (page === 'host-page' ? LOCAL_WORKSPACE : null)
    })

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({ params: { page: 'host-page' } }),
      value
    )

    expect(outcome).toMatchObject({ ok: false, error: { code: 'browser_tab_not_found' } })
    expect(dispatched).toEqual([])
  })
})

describe('resolveRemoteCliBrowserScopeSelector', () => {
  it('does nothing outside a bridged command', () => {
    expect(resolveRemoteCliBrowserScopeSelector(`id:${LOCAL_WORKSPACE}`)).toBeNull()
  })
})
