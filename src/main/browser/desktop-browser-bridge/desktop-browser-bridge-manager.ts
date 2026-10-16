/**
 * Keeps this desktop attached to exactly the managed SSH hosts that should drive its browser: those
 * with "Allow this host's orca CLI to control Orca" on, connected now, and whose server advertises
 * the bridge. Anything else is detached at once, so turning the setting off or losing the host
 * revokes the host's reach immediately.
 */
import type { DesktopBrowserBridgeRequest } from '../../../shared/desktop-browser-bridge-protocol'
import {
  DesktopBrowserBridgeConnection,
  type DesktopBrowserBridgeSubscribe
} from './desktop-browser-bridge-connection'
import type { DesktopBrowserBridgeOutcome } from './desktop-browser-bridge-executor'

export type DesktopBrowserBridgeCandidate = {
  environmentId: string
  targetId: string
  hostLabel: string
}

export type DesktopBrowserBridgeManagerDeps = {
  /** The hosts that may attach now: setting on, SSH connected, managed environment linked. */
  listCandidates(): DesktopBrowserBridgeCandidate[]
  supportsBridge(environmentId: string): Promise<boolean>
  subscribe(environmentId: string): DesktopBrowserBridgeSubscribe
  execute(
    candidate: DesktopBrowserBridgeCandidate,
    request: DesktopBrowserBridgeRequest
  ): Promise<DesktopBrowserBridgeOutcome>
  log(message: string): void
  setTimer?(run: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimer?(timer: ReturnType<typeof setTimeout>): void
}

const MIN_RETRY_MS = 2_000
const MAX_RETRY_MS = 60_000
const UNSUPPORTED_RETRY_MS = 5 * 60_000

type Entry = {
  candidate: DesktopBrowserBridgeCandidate
  connection: DesktopBrowserBridgeConnection | null
  retryTimer: ReturnType<typeof setTimeout> | null
  failures: number
  starting: boolean
}

export class DesktopBrowserBridgeManager {
  private readonly entries = new Map<string, Entry>()
  private disposed = false

  constructor(private readonly deps: DesktopBrowserBridgeManagerDeps) {}

  reconcile(): void {
    if (this.disposed) {
      return
    }
    const wanted = new Map<string, DesktopBrowserBridgeCandidate>()
    for (const candidate of this.deps.listCandidates()) {
      wanted.set(candidate.environmentId, candidate)
    }
    for (const [environmentId, entry] of this.entries) {
      const next = wanted.get(environmentId)
      if (!next || next.targetId !== entry.candidate.targetId) {
        this.detach(environmentId, 'host is no longer allowed or connected')
      } else {
        entry.candidate = next
      }
    }
    for (const [environmentId, candidate] of wanted) {
      if (!this.entries.has(environmentId)) {
        const entry: Entry = {
          candidate,
          connection: null,
          retryTimer: null,
          failures: 0,
          starting: false
        }
        this.entries.set(environmentId, entry)
        void this.start(environmentId, entry)
      }
    }
  }

  isAttached(environmentId: string): boolean {
    return this.entries.get(environmentId)?.connection?.ready === true
  }

  dispose(): void {
    this.disposed = true
    for (const environmentId of this.entries.keys()) {
      this.detach(environmentId, 'desktop is shutting down')
    }
  }

  private async start(environmentId: string, entry: Entry): Promise<void> {
    if (entry.starting || this.entries.get(environmentId) !== entry) {
      return
    }
    entry.starting = true
    let supported = false
    try {
      supported = await this.deps.supportsBridge(environmentId)
    } catch {
      supported = false
    } finally {
      entry.starting = false
    }
    if (this.entries.get(environmentId) !== entry) {
      return
    }
    if (!supported) {
      this.scheduleRetry(environmentId, entry, UNSUPPORTED_RETRY_MS)
      return
    }
    const connection = new DesktopBrowserBridgeConnection({
      subscribe: this.deps.subscribe(environmentId),
      execute: (request) => this.deps.execute(entry.candidate, request),
      onReady: () => {
        entry.failures = 0
        this.deps.log(`attached: host=${entry.candidate.hostLabel} env=${environmentId}`)
      },
      onLost: (error) => {
        if (entry.connection !== connection) {
          return
        }
        entry.connection = null
        entry.failures += 1
        this.deps.log(
          `lost: host=${entry.candidate.hostLabel} env=${environmentId} (${error.message})`
        )
        this.scheduleRetry(
          environmentId,
          entry,
          Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.min(entry.failures - 1, 5))
        )
      }
    })
    entry.connection = connection
    await connection.start()
  }

  private scheduleRetry(environmentId: string, entry: Entry, delayMs: number): void {
    if (this.disposed || this.entries.get(environmentId) !== entry || entry.retryTimer) {
      return
    }
    const setTimer = this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
    entry.retryTimer = setTimer(() => {
      entry.retryTimer = null
      // Why re-read: the setting or connection may have changed while waiting.
      const stillWanted = this.deps
        .listCandidates()
        .some((candidate) => candidate.environmentId === environmentId)
      if (!stillWanted) {
        this.detach(environmentId, 'host is no longer allowed or connected')
        return
      }
      void this.start(environmentId, entry)
    }, delayMs)
    entry.retryTimer.unref?.()
  }

  private detach(environmentId: string, reason: string): void {
    const entry = this.entries.get(environmentId)
    if (!entry) {
      return
    }
    this.entries.delete(environmentId)
    if (entry.retryTimer) {
      ;(this.deps.clearTimer ?? clearTimeout)(entry.retryTimer)
      entry.retryTimer = null
    }
    const connection = entry.connection
    entry.connection = null
    if (connection) {
      connection.close()
      this.deps.log(`detached: host=${entry.candidate.hostLabel} env=${environmentId} (${reason})`)
    }
  }
}
