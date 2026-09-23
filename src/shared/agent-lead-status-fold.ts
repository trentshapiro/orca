import type { AgentChildWorkLiveness } from './agent-status-child-work-liveness'
import type { AgentLeadStatus, AgentStatusState, AgentWorkingMode } from './agent-status-types'

export type AgentLeadStatusFoldInput = {
  /** The lead's own turn state. Anything but `done` wins over child work, except that a child
   *  blocked on a human outranks a working lead. */
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

/** A cancelled turn is the one verdict the display fold reads off the lead record. */
export function agentLeadTurnInterrupted(
  lead: Pick<AgentLeadStatus, 'outcome'> | undefined
): boolean {
  return lead?.outcome === 'cancellation'
}

/**
 * One fold for every lane that publishes a lead agent's status: a child blocked
 * on a human makes the row wait whatever the lead is doing, a settled lead with
 * live agent work is still working, and a settled lead with only watch loops is
 * monitoring. Every lane derives the liveness from its own evidence, but the
 * policy must not differ.
 */
export function foldAgentLeadStatus(input: AgentLeadStatusFoldInput): AgentLeadStatusResolution {
  // The lead's own request for a human keeps its own vocabulary (`blocked` in the structured
  // lane); a child's request surfaces only when the lead is not already asking.
  if (input.leadState === 'waiting' || input.leadState === 'blocked') {
    return { stateName: input.leadState }
  }
  if (input.childWorkLiveness === 'waiting') {
    return { stateName: 'waiting' }
  }
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
