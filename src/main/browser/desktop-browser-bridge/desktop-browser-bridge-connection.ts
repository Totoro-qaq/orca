/**
 * One desktop's attachment to one managed SSH host's orcad: a long-lived subscription over the
 * paired, end-to-end encrypted runtime connection. orcad pushes forwarded commands down it, and
 * each answer goes back over the same socket, the only one orcad accepts answers from.
 */
import {
  DesktopBrowserBridgeEvent,
  type DesktopBrowserBridgeRequest,
  type DesktopBrowserBridgeResultParams
} from '../../../shared/desktop-browser-bridge-protocol'
import type { RemoteRuntimeSubscription } from '../../../shared/remote-runtime-client'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { DesktopBrowserBridgeOutcome } from './desktop-browser-bridge-executor'

const RESULT_TIMEOUT_MS = 30_000

export type DesktopBrowserBridgeSubscribe = (callbacks: {
  onResponse(response: RuntimeRpcResponse<unknown>): void
  onError(error: Error): void
  onClose(): void
}) => Promise<RemoteRuntimeSubscription>

export class DesktopBrowserBridgeConnection {
  private subscription: RemoteRuntimeSubscription | null = null
  private attachmentId: string | null = null
  private closed = false

  constructor(
    private readonly options: {
      subscribe: DesktopBrowserBridgeSubscribe
      execute(request: DesktopBrowserBridgeRequest): Promise<DesktopBrowserBridgeOutcome>
      onReady(): void
      /** Called once, when the attachment ends for any reason other than close(). */
      onLost(error: Error): void
    }
  ) {}

  get ready(): boolean {
    return this.attachmentId !== null && !this.closed
  }

  async start(): Promise<void> {
    let subscription: RemoteRuntimeSubscription
    try {
      subscription = await this.options.subscribe({
        onResponse: (response) => this.handleResponse(response),
        onError: (error) => this.lose(error),
        onClose: () => this.lose(new Error('desktop_browser_bridge_transport_closed'))
      })
    } catch (error) {
      this.lose(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (this.closed) {
      subscription.close()
      return
    }
    this.subscription = subscription
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.attachmentId = null
    const subscription = this.subscription
    this.subscription = null
    subscription?.close()
  }

  private handleResponse(response: RuntimeRpcResponse<unknown>): void {
    if (this.closed) {
      return
    }
    if (!response.ok) {
      this.lose(new Error(`${response.error.code}: ${response.error.message}`))
      return
    }
    const parsed = DesktopBrowserBridgeEvent.safeParse(response.result)
    if (!parsed.success) {
      // Why lose rather than skip: a malformed frame means the peer is not speaking this protocol.
      this.lose(new Error('desktop_browser_bridge_invalid_event'))
      return
    }
    if (parsed.data.type === 'ready') {
      if (this.attachmentId === null) {
        this.attachmentId = parsed.data.attachmentId
        this.options.onReady()
      }
      return
    }
    if (this.attachmentId === null) {
      this.lose(new Error('desktop_browser_bridge_request_before_ready'))
      return
    }
    void this.answer(this.attachmentId, parsed.data)
  }

  private async answer(attachmentId: string, request: DesktopBrowserBridgeRequest): Promise<void> {
    const outcome = await this.options.execute(request)
    const sendRequest = this.subscription?.sendRequest
    if (this.closed || this.attachmentId !== attachmentId || !sendRequest) {
      return
    }
    const params: DesktopBrowserBridgeResultParams = outcome.ok
      ? { attachmentId, requestId: request.requestId, ok: true, result: outcome.result }
      : { attachmentId, requestId: request.requestId, ok: false, error: outcome.error }
    try {
      await sendRequest('desktopBrowserBridge.result', params, RESULT_TIMEOUT_MS)
    } catch (error) {
      console.warn(
        '[desktop-browser-bridge] Could not return a result to the host:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  private lose(error: Error): void {
    if (this.closed) {
      return
    }
    this.close()
    this.options.onLost(error)
  }
}
