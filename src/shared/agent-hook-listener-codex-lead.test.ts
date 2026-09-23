import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeHookPayload } from './agent-hook-listener'
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
})

describe('the Codex root verdict across the Stop that follows an inferred interrupt', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function post(payload: Record<string, unknown>): ReturnType<typeof normalizeHookPayload> {
    return normalizeHookPayload(state, 'codex', { paneKey: PANE_KEY, payload }, 'production')
  }

  it("keeps `cancellation` when Codex's own Stop closes the turn the server already judged", () => {
    post({ hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
    // Ctrl+C: Codex sends no hook, so the server infers the interrupt onto the root record.
    markCodexLeadTurnInterrupted(state, PANE_KEY)
    // A late Stop for that same turn carries no verdict of its own; it must not erase ours.
    const stopped = post({ hook_event_name: 'Stop' })
    expect(stopped?.payload.lead).toEqual({
      state: 'done',
      outcome: 'cancellation',
      stateStartedAt: expect.any(Number)
    })
  })

  it('drops the verdict once a new root turn starts', () => {
    post({ hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
    markCodexLeadTurnInterrupted(state, PANE_KEY)
    post({ hook_event_name: 'Stop' })
    const resumed = post({ hook_event_name: 'UserPromptSubmit', prompt: 'again' })
    expect(resumed?.payload.lead).toEqual({ state: 'working', stateStartedAt: expect.any(Number) })
    const finished = post({ hook_event_name: 'Stop' })
    expect(finished?.payload.lead).toEqual({ state: 'done', stateStartedAt: expect.any(Number) })
  })

  it('carries the verdict through a relayed root Stop the same way', () => {
    markCodexLeadTurnInterrupted(state, PANE_KEY)
    const reconciled = reconcileRemoteCodexState(
      state,
      PANE_KEY,
      'Stop',
      undefined,
      { state: 'done', prompt: 'ship', agentType: 'codex' },
      undefined
    )
    expect(reconciled.lead).toEqual({
      state: 'done',
      outcome: 'cancellation',
      stateStartedAt: expect.any(Number)
    })
  })
})
