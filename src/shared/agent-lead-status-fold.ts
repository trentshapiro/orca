import type { AgentChildWorkLiveness } from './agent-status-child-work-liveness'
import type { AgentLeadStatus, AgentStatusState, AgentWorkingMode } from './agent-status-types'

export type AgentLeadStatusFoldInput = {
  /** The lead's own turn state. Anything but `done` wins outright. */
  leadState: AgentStatusState
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
 *
 * How the lead's turn ended is not an input. A cancel is a verdict on the lead
 * (`lead.outcome`), never on the shell or subagent it left running: that work
 * leaves the fold only when it reports its own end or the session ends.
 */
export function foldAgentLeadStatus(input: AgentLeadStatusFoldInput): AgentLeadStatusResolution {
  if (input.leadState !== 'done') {
    return { stateName: input.leadState }
  }
  if (input.childWorkLiveness === 'working') {
    return { stateName: 'working' }
  }
  if (input.childWorkLiveness === 'monitoring') {
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
