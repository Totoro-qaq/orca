import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'

const SCOPE_REPLY_TIMEOUT_MS = 5_000

/**
 * Asks the renderer, which owns the workspace-to-host map, whether `environmentId`'s own machine
 * owns `workspaceId`. No window, a timeout or a malformed reply all answer no.
 */
export function rendererAuthorizesRemoteCliWorkspace(
  getWindow: () => BrowserWindow | null,
  environmentId: string,
  workspaceId: string
): Promise<boolean> {
  const win = getWindow()
  if (!win || win.isDestroyed()) {
    return Promise.resolve(false)
  }
  const requestId = randomUUID()
  return new Promise<boolean>((resolve) => {
    const finish = (allowed: boolean): void => {
      clearTimeout(timer)
      ipcMain.removeListener('browser:remoteCliScopeReply', handler)
      resolve(allowed)
    }
    const handler = (event: Electron.IpcMainEvent, reply: unknown): void => {
      if (
        event.sender !== win.webContents ||
        !reply ||
        typeof reply !== 'object' ||
        !('requestId' in reply) ||
        reply.requestId !== requestId
      ) {
        return
      }
      finish('allowed' in reply && reply.allowed === true)
    }
    const timer = setTimeout(() => finish(false), SCOPE_REPLY_TIMEOUT_MS)
    ipcMain.on('browser:remoteCliScopeReply', handler)
    win.webContents.send('browser:requestRemoteCliScope', { requestId, environmentId, workspaceId })
  })
}
