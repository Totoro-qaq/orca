/**
 * Workspaces whose desktop pages an SSH host has driven through the bridge. Their pages lose the
 * auto-granted programmatic clipboard read for the rest of this run, so a host's script cannot
 * read the desktop clipboard through a page it controls. Typing and paste by the user still work.
 */
import { browserManager } from '../browser-manager'

const drivenWorkspaceIds = new Set<string>()

export function markRemoteCliDrivenWorkspace(workspaceId: string): void {
  drivenWorkspaceIds.add(workspaceId)
}

export function isRemoteCliDrivenGuest(webContentsId: number | undefined): boolean {
  if (webContentsId === undefined || drivenWorkspaceIds.size === 0) {
    return false
  }
  const pageId = browserManager.getTabIdForWebContentsId(webContentsId)
  const workspaceId = pageId ? browserManager.getWorktreeIdForTab(pageId) : undefined
  return workspaceId !== undefined && drivenWorkspaceIds.has(workspaceId)
}

export function resetRemoteCliDrivenWorkspacesForTests(): void {
  drivenWorkspaceIds.clear()
}
