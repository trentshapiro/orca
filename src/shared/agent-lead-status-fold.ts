import type { AgentChildWorkLiveness } from './agent-status-child-work-liveness'
import type { AgentLeadStatus, AgentStatusState, AgentWorkingMode } from './agent-status-types'

export type AgentLeadStatusFoldInput = {
  /** The lead's own turn state. Anything but `done` wins outright. */
  leadState: AgentStatusState
  /** A lead turn that ended by interrupt keeps a watch loop from reading as monitoring;
   *  live agent work still counts, because it outlives the interrupt. */
  interrupted: boolean
  childWorkLiveness: AgentChildWorkLiveness
}

export type AgentLeadStatusResolution = {
  stateName: AgentStatusState
  workingMode?: AgentWorkingMode
}

/**
 * One fold for every lane that publishes a lead agent's status: a settled lead
 * with live agent work is still working, and a settled lead with only watch
 * loops is monitoring. The hook lane and the structured session lane derive
 * the liveness from different evidence, but the policy must not differ.
 */
export function foldAgentLeadStatus(input: AgentLeadStatusFoldInput): AgentLeadStatusResolution {
  if (input.leadState !== 'done') {
    return { stateName: input.leadState }
  }
  if (input.childWorkLiveness === 'working') {
    return { stateName: 'working' }
  }
  if (input.childWorkLiveness === 'monitoring' && !input.interrupted) {
    return { stateName: 'working', workingMode: 'monitoring' }
  }
  return { stateName: 'done' }
}

/** The lead settled and live child work is the only thing holding the row open. Derived,
 *  never stored: a stored copy could disagree with the two facts it is made of. */
export function isAgentStatusHeldOpenByChildWork(row: {
  state: AgentStatusState
  lead?: Pick<AgentLeadStatus, 'state'>
}): boolean {
  return row.lead?.state === 'done' && row.state !== 'done'
}

/**
 * Agent execution is owed: the lead's own turn runs, or a settled lead's live agent child work
 * still holds the row `working`. A watch loop (`monitoring`) owes nothing — the fold reads it
 * that way on purpose — and a lead paused on a prompt owes nothing even if a child runs, matching
 * the combined `state` a reader saw before `lead` existed. Without `lead` (an old host) the
 * combined `state` is all there is, and `working` is read exactly as it was before.
 */
export function isAgentExecutionOwed(row: {
  state: AgentStatusState
  workingMode?: AgentWorkingMode
  lead?: Pick<AgentLeadStatus, 'state'>
}): boolean {
  if (!row.lead) {
    return row.state === 'working'
  }
  if (row.lead.state === 'working') {
    return true
  }
  return row.lead.state === 'done' && row.state === 'working' && row.workingMode !== 'monitoring'
}

/** The lead's clock follows the same continuity rule as the row's: an unchanged lead state
 *  keeps the instant it first appeared, a changed one starts at `now`. A caller that knows
 *  the real instant (a restored stash, a journal record) passes it and wins. */
export function continueAgentLeadStatus(
  previous: Pick<AgentLeadStatus, 'state' | 'stateStartedAt'> | undefined,
  next: { state: AgentStatusState; outcome?: AgentLeadStatus['outcome']; stateStartedAt?: number },
  now: number
): AgentLeadStatus {
  const stateStartedAt =
    next.stateStartedAt ??
    (previous && previous.state === next.state ? previous.stateStartedAt : now)
  return {
    state: next.state,
    ...(next.state === 'done' && next.outcome ? { outcome: next.outcome } : {}),
    stateStartedAt
  }
}
