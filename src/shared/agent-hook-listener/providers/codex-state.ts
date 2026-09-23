import type { AgentLeadStatus, ParsedAgentStatusPayload } from '../../agent-status-types'
import type { AgentJournalTurnOutcome } from '../../agent-turn-outcome'
import {
  agentLeadTurnInterrupted,
  continueAgentLeadStatus,
  foldAgentLeadStatus,
  type AgentLeadStatusResolution
} from '../../agent-lead-status-fold'
import {
  codexRosterChildWorkLiveness,
  codexRosterToSnapshots,
  finishCodexSubagent,
  seedCodexSubagentRoster,
  type CodexSubagentRoster
} from '../../codex-subagent-roster'
import {
  createCodexSubagentTranscriptState,
  hasTrackedCodexTranscriptSubagents,
  type CodexSubagentTranscriptState
} from '../../codex-subagent-transcript'
import type { CodexLeadTurnState, HookListenerState } from '../listener-state'

export function getOrCreateCodexSubagentRoster(
  state: HookListenerState,
  paneKey: string
): CodexSubagentRoster {
  let roster = state.codexSubagentRosterByPaneKey.get(paneKey)
  if (!roster) {
    roster = new Map()
    state.codexSubagentRosterByPaneKey.set(paneKey, roster)
  }
  return roster
}

export function getOrCreateCodexSubagentTranscriptState(
  state: HookListenerState,
  paneKey: string
): CodexSubagentTranscriptState {
  let transcriptState = state.codexSubagentTranscriptByPaneKey.get(paneKey)
  if (!transcriptState) {
    transcriptState = createCodexSubagentTranscriptState()
    state.codexSubagentTranscriptByPaneKey.set(paneKey, transcriptState)
  }
  return transcriptState
}

export function hasCodexTranscriptSubagents(state: HookListenerState, paneKey: string): boolean {
  return hasTrackedCodexTranscriptSubagents(state.codexSubagentTranscriptByPaneKey.get(paneKey))
}

/** The only writer of the root record; the root's clock keeps continuity across same-state writes. */
export function setCodexLeadTurnState(
  state: HookListenerState,
  paneKey: string,
  next: Omit<CodexLeadTurnState, 'stateStartedAt'> & { stateStartedAt?: number },
  now = Date.now()
): CodexLeadTurnState {
  const previous = state.codexLeadStateByPaneKey.get(paneKey)
  const continued = continueAgentLeadStatus(previous, next, now)
  const lead: CodexLeadTurnState = {
    state: next.state,
    ...(continued.outcome ? { outcome: continued.outcome } : {}),
    stateStartedAt: continued.stateStartedAt,
    model: next.model
  }
  state.codexLeadStateByPaneKey.set(paneKey, lead)
  return lead
}

/** The combined row state for a Codex pane: the root record and its roster through the same
 *  fold every other lane uses. */
export function resolveCodexPaneStatus(
  state: HookListenerState,
  paneKey: string,
  lead: Pick<CodexLeadTurnState, 'state' | 'outcome'>
): AgentLeadStatusResolution {
  return foldAgentLeadStatus({
    leadState: lead.state,
    interrupted: agentLeadTurnInterrupted(lead),
    childWorkLiveness: codexRosterChildWorkLiveness(state.codexSubagentRosterByPaneKey.get(paneKey))
  })
}

/** Codex's own Stop carries no verdict, so a turn boundary that lands on a cancelled root keeps
 *  the cancellation Orca inferred, as the Claude lane carries its inferred interrupt into the
 *  late Stop. Any live event in between has already replaced the record and drops it. */
export function codexCarriedTurnOutcome(
  previous: Pick<CodexLeadTurnState, 'state' | 'outcome'> | undefined
): AgentJournalTurnOutcome | undefined {
  return previous?.state === 'done' && agentLeadTurnInterrupted(previous)
    ? 'cancellation'
    : undefined
}

/** The `lead` fact a Codex row publishes, straight from the root record. */
export function codexLeadStatusForPayload(
  lead: CodexLeadTurnState | undefined
): AgentLeadStatus | undefined {
  return lead
    ? {
        state: lead.state,
        ...(lead.state === 'done' && lead.outcome ? { outcome: lead.outcome } : {}),
        stateStartedAt: lead.stateStartedAt
      }
    : undefined
}

export function seedCodexStateFromSnapshot(
  state: HookListenerState,
  paneKey: string,
  payload: Pick<ParsedAgentStatusPayload, 'model' | 'state' | 'subagents' | 'lead'>
): void {
  const snapshots = payload.subagents ?? []
  if (snapshots.length > 0 && !state.codexSubagentRosterByPaneKey.has(paneKey)) {
    seedCodexSubagentRoster(getOrCreateCodexSubagentRoster(state, paneKey), snapshots)
  }
  if (!state.codexLeadStateByPaneKey.has(paneKey)) {
    const lead = payload.lead
    // Why: child hooks after restart omit the root model; seed it from durable status before they can overwrite the cache.
    // A row that carries the root's own state is the fact; only an older row makes us infer it.
    if (lead && lead.state !== 'blocked') {
      setCodexLeadTurnState(state, paneKey, {
        state: lead.state,
        ...(lead.outcome ? { outcome: lead.outcome } : {}),
        stateStartedAt: lead.stateStartedAt,
        model: payload.model
      })
      return
    }
    setCodexLeadTurnState(state, paneKey, {
      // Why: a child wait drives the aggregate waiting state, so it is not evidence that the root itself was waiting.
      state:
        payload.state === 'done'
          ? 'done'
          : payload.state === 'waiting' &&
              !snapshots.some((snapshot) => snapshot.state === 'waiting')
            ? 'waiting'
            : 'working',
      model: payload.model
    })
  }
}

/** Sync the Codex lead record when the server infers an interrupt, so delayed child events cannot restore stale working state. */
export function markCodexLeadTurnInterrupted(state: HookListenerState, paneKey: string): void {
  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  setCodexLeadTurnState(state, paneKey, {
    state: 'done',
    outcome: 'cancellation',
    model: lead?.model
  })
}

export function codexLeadStateForHookEvent(
  eventName: string | undefined,
  normalizedState?: ParsedAgentStatusPayload['state']
): CodexLeadTurnState['state'] | undefined {
  if (eventName === 'Stop') {
    return 'done'
  }
  if (eventName === 'PermissionRequest') {
    // Why: the execution host's normalizer already ruled on whether this approval is human-owned
    // or reviewer-owned, reading the reviewer off that host's rollout (STA-7698). Re-deriving
    // 'waiting' from the event name here would discard that verdict for every relayed pane.
    return normalizedState === 'working' ? 'working' : 'waiting'
  }
  if (
    eventName === 'SessionStart' ||
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  ) {
    return 'working'
  }
  return undefined
}

/** Why: relay restarts lose lead/roster state; merge child events into main's longer-lived cache. */
export function reconcileRemoteCodexState(
  state: HookListenerState,
  paneKey: string,
  eventName: string | undefined,
  agentId: string | undefined,
  payload: ParsedAgentStatusPayload,
  previous: ParsedAgentStatusPayload | undefined
): ParsedAgentStatusPayload {
  if (previous?.agentType === 'codex') {
    seedCodexStateFromSnapshot(state, paneKey, previous)
  } else {
    seedCodexStateFromSnapshot(state, paneKey, payload)
  }

  // Why: older relays send child identity without roster snapshots; keep their already-normalized aggregate authoritative.
  if (agentId && !payload.subagents && !state.codexSubagentRosterByPaneKey.has(paneKey)) {
    return payload
  }
  const roster = getOrCreateCodexSubagentRoster(state, paneKey)
  if (payload.subagents) {
    seedCodexSubagentRoster(roster, payload.subagents)
  }
  if (agentId) {
    if (eventName === 'SubagentStop') {
      finishCodexSubagent(roster, agentId)
    }
  } else {
    const leadState = codexLeadStateForHookEvent(eventName, payload.state)
    if (eventName === 'SessionStart' || (eventName === 'Stop' && !payload.subagents)) {
      roster.clear()
    }
    if (leadState) {
      const previousLead = state.codexLeadStateByPaneKey.get(paneKey)
      const outcome = leadState === 'done' ? codexCarriedTurnOutcome(previousLead) : undefined
      setCodexLeadTurnState(state, paneKey, {
        state: leadState,
        ...(outcome ? { outcome } : {}),
        model: payload.model ?? previousLead?.model
      })
    }
  }

  const lead = state.codexLeadStateByPaneKey.get(paneKey)
  if (!lead) {
    return payload
  }
  const resolution = resolveCodexPaneStatus(state, paneKey, lead)
  // Child lifecycle hooks commonly omit the root prompt. Preserve the last known
  // turn label while merging their roster/state so relay restarts do not blank it.
  const prompt =
    agentId && payload.prompt.length === 0 && previous?.agentType === 'codex'
      ? previous.prompt
      : payload.prompt
  return {
    ...payload,
    prompt,
    state: resolution.stateName,
    workingMode: resolution.workingMode,
    model: lead.model ?? payload.model,
    subagents: codexRosterToSnapshots(roster),
    // Why: main's cache outlives a relay restart, so it is the lead fact for a relayed row too.
    lead: codexLeadStatusForPayload(lead)
  }
}
