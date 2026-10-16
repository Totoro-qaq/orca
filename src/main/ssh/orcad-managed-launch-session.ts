/**
 * Whether a managed orcad on a macOS host outlived the SSH session that started it (#25934), and
 * the restart that re-attributes it to the current session. See orcad-launch-ssh-session.ts.
 */
import type { OrcadManagedRestartResult } from '../../shared/orcad-managed-runtime'
import { withOrcadActivationLock } from './orcad-activation-lock'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import {
  orcadLaunchSshSessionProbeCommand,
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
import { orcadStopFreedTheHost } from './orcad-remote-process-control'
import { orcadSlotDir, stopOrcadSlot } from './orcad-recovery-slot'
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
 * Stops the active slot and starts it again from this client's SSH session. Only on a host with
 * no terminals: the daemon would survive the restart, and with it the old attribution.
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
      async () => {
        // Re-read under the fence: another client may have changed the active slot.
        const active = (await readOrcadActivationRecord(slot)).active
        return active ? stopOrcadSlot(slot, orcadSlotDir(slot, active), false) : 'no-pid'
      },
      () => 'fenced' as const
    )
    if (stopped === 'fenced') {
      return {
        outcome: 'not-restarted',
        reason: 'An update, rollback or recovery holds this host; try again when it finishes.'
      }
    }
    if (!orcadStopFreedTheHost(stopped)) {
      return {
        outcome: 'not-restarted',
        reason: `The managed server could not be confirmed stopped (${stopped}); it was left running.`
      }
    }
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
    return { outcome: 'restarted', environmentId: environment.id }
  })
}
