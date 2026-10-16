/**
 * Whether a managed orcad on a macOS host outlived the SSH session that started it (#25934), and
 * the restart that re-attributes it to the current session. See orcad-launch-ssh-session.ts.
 */
import { randomUUID } from 'node:crypto'
import type { OrcadManagedRestartResult } from '../../shared/orcad-managed-runtime'
import { withOrcadActivationLock, type OrcadActivationLockControl } from './orcad-activation-lock'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import {
  carryOrcadLaunchSshSessionCommand,
  orcadLaunchSshSessionOf,
  orcadLaunchSshSessionProbeCommand,
  readOrcadLaunchSshSessionCommand,
  parseOrcadLaunchSshSession,
  recordsOrcadLaunchSshSession,
  type OrcadLaunchSshSession
} from './orcad-launch-ssh-session'
import { withManagedOrcadLifecycle } from './orcad-runtime-maintenance'
import {
  managedOrcadInstallDir,
  managedOrcadSlot,
  requireManagedOrcadEnvironment,
  resolveLinkedOrcadContext
} from './orcad-managed-runtime-context'
import { rebuildOrcadManagedTunnel } from './orcad-managed-tunnel'
import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import { readRemoteOrcadManagedStopTarget } from './orcad-managed-remote-stop'
import { orcadSlotDir, type OrcadSlotOptions } from './orcad-recovery-slot'
import { stopIncumbentBehindTerminalBarrier } from './orcad-rollback-terminal-barrier'
import { execOrcadRemote } from './orcad-remote-runtime-control'
import { collectManagedTerminalCensus } from './orcad-terminal-census-client'

export async function readManagedOrcadLaunchSshSession(
  userDataPath: string,
  environmentId: string
): Promise<OrcadLaunchSshSession> {
  const { environment, deployment } = requireManagedOrcadEnvironment(userDataPath, environmentId)
  const context = await resolveLinkedOrcadContext(environment, deployment)
  if (!recordsOrcadLaunchSshSession(context.host)) {
    return 'not-applicable'
  }
  const active = context.activationRecord.active
  if (!active) {
    return 'not-recorded'
  }
  return parseOrcadLaunchSshSession(
    await execOrcadRemote(
      { conn: context.connection, host: context.host },
      orcadLaunchSshSessionProbeCommand(context.host, managedOrcadInstallDir(context, active))
    )
  )
}

/**
 * Stops the active slot, retiring its idle terminal daemon, and starts it again from this
 * client's SSH session. Only on a host with no terminals: a surviving daemon keeps the old
 * attribution for every terminal it spawns.
 */
export function restartManagedOrcadEnvironment(
  userDataPath: string,
  selector: string
): Promise<OrcadManagedRestartResult> {
  return withManagedOrcadLifecycle(userDataPath, selector, async ({ environment, deployment }) => {
    const context = await resolveLinkedOrcadContext(environment, deployment)
    if (!context.activationRecord.active) {
      return { outcome: 'not-restarted', reason: 'This host has no activated managed server.' }
    }
    // Why release: a finished automation shell no client used must not hold the restart back.
    const census = await collectManagedTerminalCensus(
      userDataPath,
      environment,
      context.activationRecord,
      undefined,
      { releaseFinishedAutomationTerminals: true }
    )
    if (census.liveSessions !== 0) {
      return { outcome: 'terminals-running', liveSessions: census.liveSessions }
    }
    const slot = managedOrcadSlot(context, deployment.remotePort)
    const stopped = await withOrcadActivationLock(
      slot,
      (lock) => stopRetiringIdleDaemon(slot, lock),
      (): StopOutcome => ({
        state: 'kept',
        reason: 'An update, rollback or recovery holds this host; try again when it finishes.'
      })
    )
    if (stopped.state === 'kept') {
      return { outcome: 'not-restarted', reason: stopped.reason }
    }
    // Started even when the daemon stayed: a stopped server serves nothing.
    const wake = await wakeStoppedManagedOrcad(slot)
    if (wake.outcome !== 'started' && wake.outcome !== 'serving') {
      return {
        outcome: 'not-restarted',
        reason:
          wake.outcome === 'recovery-refused'
            ? wake.reason
            : `The managed server stopped but did not start again (${wake.outcome}); reconnect to start it.`
      }
    }
    // The started server may have bound another port than the forward in use.
    await rebuildOrcadManagedTunnel(userDataPath, environment.id)
    const dir = orcadSlotDir(slot, stopped.version)
    if (stopped.state === 'daemon-kept') {
      if (stopped.session) {
        // Keeps the warning on later connects: the surviving daemon still has the ended session.
        await execOrcadRemote(
          slot,
          carryOrcadLaunchSshSessionCommand(slot.host, dir, stopped.session)
        ).catch(() => {})
      }
      return { outcome: 'not-restarted', reason: stopped.reason }
    }
    const session = parseOrcadLaunchSshSession(
      await execOrcadRemote(slot, orcadLaunchSshSessionProbeCommand(slot.host, dir))
    )
    if (session === 'exited') {
      return {
        outcome: 'not-restarted',
        reason:
          'The managed server restarted, but the SSH session that started it has already ' +
          'ended. This connection opens a new SSH session for each command; turn on SSH ' +
          'connection reuse for this host, then restart again.'
      }
    }
    return { outcome: 'restarted', environmentId: environment.id }
  })
}

type StopOutcome =
  | { state: 'retired'; version: string }
  /** orcad exited but its daemon, which spawns every terminal, kept the old attribution. */
  | { state: 'daemon-kept'; version: string; reason: string; session: string | null }
  /** orcad keeps serving, or may still be stopping: nothing is started. */
  | { state: 'kept'; reason: string }

/** The rollback's managed stop: orcad retires its daemon only when no session exists then. */
async function stopRetiringIdleDaemon(
  slot: OrcadSlotOptions,
  lock: OrcadActivationLockControl
): Promise<StopOutcome> {
  // Re-read under the fence: another client may have changed the active slot.
  const active = (await readOrcadActivationRecord(slot)).active
  if (!active) {
    return { state: 'kept', reason: 'This host has no activated managed server.' }
  }
  const target = await readRemoteOrcadManagedStopTarget(slot, active)
  if (target.state === 'refused') {
    return { state: 'kept', reason: target.reason }
  }
  const session = orcadLaunchSshSessionOf(
    await execOrcadRemote(
      slot,
      readOrcadLaunchSshSessionCommand(slot.host, orcadSlotDir(slot, active))
    ).catch(() => '')
  )
  const barrier = await stopIncumbentBehindTerminalBarrier(slot, randomUUID(), target.context)
  switch (barrier.state) {
    case 'retired':
      return { state: 'retired', version: active }
    case 'unproven':
      return {
        state: 'daemon-kept',
        version: active,
        session,
        reason:
          'The managed server restarted, but its terminal daemon kept running because a terminal ' +
          'was open at the stop, so terminals may still lack local network access.'
      }
    case 'unsettled':
      // orcad may still be stopping; like the rollback, the fence stays until recovery drops it.
      lock.retain()
      return { state: 'kept', reason: barrier.reason }
    case 'withdrawn':
      return { state: 'kept', reason: barrier.reason }
  }
}
