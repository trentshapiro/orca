import { describe, expect, it } from 'vitest'
import { agentStatusChangedPayloadSchema } from '../../shared/plugins/plugin-events'
import { projectPluginAgentStatusChangedPayload } from './plugin-agent-status-event'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function row(
  overrides: Partial<Parameters<typeof projectPluginAgentStatusChangedPayload>[0]> = {}
): Parameters<typeof projectPluginAgentStatusChangedPayload>[0] {
  return {
    paneKey: PANE,
    worktreeId: 'wt-1',
    receivedAt: 1_700_000_000_000,
    payload: { state: 'working', prompt: 'ship it', agentType: 'claude' },
    ...overrides
  }
}

describe('projectPluginAgentStatusChangedPayload', () => {
  it('publishes the lead fact beside the combined state, and the schema admits it', () => {
    const projected = projectPluginAgentStatusChangedPayload(
      row({
        payload: {
          state: 'working',
          prompt: 'ship it',
          agentType: 'claude',
          lead: { state: 'done', outcome: 'cancellation', stateStartedAt: 1_700_000_000_500 }
        }
      })
    )
    expect(projected).toEqual({
      worktreeId: 'wt-1',
      paneKey: PANE,
      state: 'working',
      receivedAt: 1_700_000_000_000,
      lead: { state: 'done', outcome: 'cancellation', stateStartedAt: 1_700_000_000_500 }
    })
    // The bus validates before delivery; a field the schema strips never reaches a plugin.
    expect(agentStatusChangedPayloadSchema.parse(projected)).toEqual(projected)
  })

  it("leaves `lead` absent for a row that carries none, so an old host's rows look as they did", () => {
    const projected = projectPluginAgentStatusChangedPayload(row())
    expect(projected).toEqual({
      worktreeId: 'wt-1',
      paneKey: PANE,
      state: 'working',
      receivedAt: 1_700_000_000_000
    })
    expect(projected).not.toHaveProperty('lead')
  })

  it('projects a restored row to nothing, even when its lead reads working', () => {
    expect(
      projectPluginAgentStatusChangedPayload(
        row({
          restoredUnconfirmed: true,
          payload: {
            state: 'working',
            prompt: 'ship it',
            agentType: 'claude',
            lead: { state: 'working', stateStartedAt: 1 }
          }
        })
      )
    ).toBeNull()
  })

  it('keeps a missing worktree as null and never invents a verdict on a live lead', () => {
    const projected = projectPluginAgentStatusChangedPayload(
      row({
        worktreeId: undefined,
        payload: {
          state: 'working',
          prompt: '',
          agentType: 'codex',
          lead: { state: 'working', stateStartedAt: 7 }
        }
      })
    )
    expect(projected?.worktreeId).toBeNull()
    expect(projected?.lead).toEqual({ state: 'working', stateStartedAt: 7 })
  })
})
