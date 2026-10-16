/**
 * The desktop browser bridge: a managed SSH host's orcad forwards browser commands from the host's
 * own `orca` CLI to a desktop that opted in with "Allow this host's orca CLI to control Orca".
 *
 * Both sides gate on DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY: orcad advertises it in status, and
 * the desktop declares it on the socket it attaches with. A peer without it never attaches, so the
 * CLI gets DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE instead of a silent hang.
 */
import { z } from 'zod'

export const DESKTOP_BROWSER_BRIDGE_RUNTIME_CAPABILITY = 'browser.desktopBridge.v1'

export const DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_CODE = 'desktop_browser_bridge_unavailable'
export const DESKTOP_BROWSER_BRIDGE_NOT_FORWARDED_CODE = 'desktop_browser_bridge_not_forwarded'
export const DESKTOP_BROWSER_BRIDGE_SCOPE_CODE = 'desktop_browser_bridge_out_of_scope'

export const DESKTOP_BROWSER_BRIDGE_SETTING_LABEL = "Allow this host's orca CLI to control Orca"

export const DESKTOP_BROWSER_BRIDGE_UNAVAILABLE_MESSAGE = `No Orca desktop is sharing its browser with this host. On your desktop, open this host's SSH settings, turn on "${DESKTOP_BROWSER_BRIDGE_SETTING_LABEL}", and keep the host connected. The desktop needs an Orca version that supports it.`

/**
 * The only commands a host may run on the desktop browser. Narrower than the relay bridge before
 * 1.4.225, which ran any CLI command on the desktop: nothing here reads or writes desktop files
 * (upload, download, pdf), reads the desktop clipboard or cookie jar, runs raw agent-browser
 * commands, changes browser profiles or identity, or bypasses certificate errors.
 */
export const DESKTOP_BROWSER_BRIDGE_METHODS: ReadonlySet<string> = new Set([
  'browser.tabList',
  'browser.tabCurrent',
  'browser.tabShow',
  'browser.tabSwitch',
  'browser.tabCreate',
  'browser.tabClose',
  'browser.goto',
  'browser.back',
  'browser.forward',
  'browser.reload',
  'browser.snapshot',
  'browser.screenshot',
  'browser.fullScreenshot',
  'browser.get',
  'browser.is',
  'browser.find',
  'browser.wait',
  'browser.eval',
  'browser.console',
  'browser.network',
  'browser.click',
  'browser.dblclick',
  'browser.fill',
  'browser.type',
  'browser.select',
  'browser.check',
  'browser.focus',
  'browser.clear',
  'browser.selectAll',
  'browser.hover',
  'browser.drag',
  'browser.scroll',
  'browser.scrollIntoView',
  'browser.highlight',
  'browser.keypress',
  'browser.keyboardInsertText',
  'browser.mouseMove',
  'browser.mouseDown',
  'browser.mouseUp',
  'browser.mouseClick',
  'browser.mouseWheel',
  'browser.viewport',
  'browser.dialogAccept',
  'browser.dialogDismiss'
])

export function isDesktopBrowserBridgeMethod(method: string): boolean {
  return DESKTOP_BROWSER_BRIDGE_METHODS.has(method)
}

const Identity = z.string().min(1).max(256)
const MAX_FORWARDED_PARAMS_BYTES = 1024 * 1024

export const DesktopBrowserBridgeAttachParams = z.object({
  bridgeClientId: Identity
})

export const DesktopBrowserBridgeRequest = z.object({
  type: z.literal('request'),
  requestId: Identity,
  method: z.string().refine(isDesktopBrowserBridgeMethod, 'method is not forwarded'),
  /** The workspace orcad resolved the caller's selector to; absent when it named none. */
  workspaceId: Identity.optional(),
  params: z
    .record(z.string(), z.unknown())
    .refine(
      (value) => JSON.stringify(value).length <= MAX_FORWARDED_PARAMS_BYTES,
      'params exceed the forwarded size budget'
    )
})
export type DesktopBrowserBridgeRequest = z.infer<typeof DesktopBrowserBridgeRequest>

export const DesktopBrowserBridgeEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), attachmentId: Identity }),
  DesktopBrowserBridgeRequest
])
export type DesktopBrowserBridgeEvent = z.infer<typeof DesktopBrowserBridgeEvent>

const BridgeError = z.object({
  code: z.string().min(1).max(128),
  message: z.string().max(4096)
})

export const DesktopBrowserBridgeResultParams = z.discriminatedUnion('ok', [
  z.object({
    attachmentId: Identity,
    requestId: Identity,
    ok: z.literal(true),
    result: z.unknown()
  }),
  z.object({
    attachmentId: Identity,
    requestId: Identity,
    ok: z.literal(false),
    error: BridgeError
  })
])
export type DesktopBrowserBridgeResultParams = z.infer<typeof DesktopBrowserBridgeResultParams>
