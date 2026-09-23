import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import {
  markCodexLeadTurnInterrupted,
  reconcileRemoteCodexState,
  seedCodexStateFromSnapshot
} from './agent-hook-listener/providers/codex-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'

describe('the Codex root record seeded from a durable row', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it("takes the row's own lead fact over the inferred aggregate", () => {
    seedCodexStateFromSnapshot(state, PANE_KEY, {
      state: 'waiting',
      model: 'gpt-5.4',
      subagents: [{ id: 'child', state: 'working', startedAt: 1 }],
      lead: { state: 'done', outcome: 'cancellation', stateStartedAt: 42 }
    })
    expect(state.codexLeadStateByPaneKey.get(PANE_KEY)).toEqual({
      state: 'done',
      outcome: 'cancellation',
      stateStartedAt: 42,
      model: 'gpt-5.4'
    })
  })

  it('still infers the root state from an older row that carries no lead', () => {
    seedCodexStateFromSnapshot(state, PANE_KEY, {
      state: 'waiting',
      subagents: [{ id: 'child', state: 'waiting', startedAt: 1 }]
    })
    expect(state.codexLeadStateByPaneKey.get(PANE_KEY)).toMatchObject({ state: 'working' })
  })

  it("republishes a relayed row with the lead fact main holds, not the relay's", () => {
    const reconciled = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'Stop',
      undefined,
      { state: 'done', prompt: 'ship', agentType: 'codex' },
      undefined
    )
    expect(reconciled.lead).toEqual({ state: 'done', stateStartedAt: expect.any(Number) })
  })

  it('carries the cancellation Orca inferred into a late relayed Stop', () => {
    markCodexLeadTurnInterrupted(state, PANE_KEY)
    const reconciled = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'Stop',
      undefined,
      { state: 'done', prompt: 'ship', agentType: 'codex' },
      undefined
    )
    expect(reconciled.lead).toMatchObject({ state: 'done', outcome: 'cancellation' })
  })

  it('folds a relayed waiting child through the shared rule, keeping the root fact', () => {
    // An older relay that never folded a child wait sends `working`; main re-derives the row.
    const reconciled = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'PermissionRequest',
      'child',
      {
        state: 'working',
        prompt: 'ship',
        agentType: 'codex',
        subagents: [{ id: 'child', state: 'waiting', startedAt: 1 }]
      },
      undefined
    )
    expect(reconciled).toMatchObject({ state: 'waiting', lead: { state: 'working' } })
  })
})
