import { describe, expect, it } from 'vitest'
import {
  agentLeadTurnInterrupted,
  continueAgentLeadStatus,
  foldAgentLeadStatus,
  isAgentStatusHeldOpenByChildWork
} from './agent-lead-status-fold'

describe('foldAgentLeadStatus', () => {
  it('keeps a lead that is not settled, whatever its children do', () => {
    expect(
      foldAgentLeadStatus({
        leadState: 'blocked',
        interrupted: false,
        childWorkLiveness: 'working'
      })
    ).toEqual({ stateName: 'blocked' })
  })

  it('reads a settled lead with live agent work as working', () => {
    expect(
      foldAgentLeadStatus({ leadState: 'done', interrupted: false, childWorkLiveness: 'working' })
    ).toEqual({ stateName: 'working' })
  })

  it('reads a settled lead with only watch loops as monitoring', () => {
    expect(
      foldAgentLeadStatus({
        leadState: 'done',
        interrupted: false,
        childWorkLiveness: 'monitoring'
      })
    ).toEqual({ stateName: 'working', workingMode: 'monitoring' })
  })

  it('does not read a watch loop as monitoring after an interrupt, but keeps agent work', () => {
    expect(
      foldAgentLeadStatus({ leadState: 'done', interrupted: true, childWorkLiveness: 'monitoring' })
    ).toEqual({ stateName: 'done' })
    expect(
      foldAgentLeadStatus({ leadState: 'done', interrupted: true, childWorkLiveness: 'working' })
    ).toEqual({ stateName: 'working' })
  })

  it('settles when nothing is running', () => {
    expect(
      foldAgentLeadStatus({ leadState: 'done', interrupted: false, childWorkLiveness: null })
    ).toEqual({ stateName: 'done' })
  })

  describe('a child blocked on a human', () => {
    it('makes a working or settled lead wait, even after an interrupt', () => {
      for (const leadState of ['working', 'done'] as const) {
        for (const interrupted of [false, true]) {
          expect(
            foldAgentLeadStatus({ leadState, interrupted, childWorkLiveness: 'waiting' })
          ).toEqual({ stateName: 'waiting' })
        }
      }
    })

    it("yields to the lead's own request for a human, in the lead's own vocabulary", () => {
      for (const leadState of ['waiting', 'blocked'] as const) {
        expect(
          foldAgentLeadStatus({ leadState, interrupted: false, childWorkLiveness: 'waiting' })
        ).toEqual({ stateName: leadState })
      }
    })
  })
})

describe('agentLeadTurnInterrupted', () => {
  it('reads only a cancellation verdict as an interrupt', () => {
    expect(agentLeadTurnInterrupted({ outcome: 'cancellation' })).toBe(true)
    expect(agentLeadTurnInterrupted({ outcome: 'failure' })).toBe(false)
    expect(agentLeadTurnInterrupted({})).toBe(false)
    expect(agentLeadTurnInterrupted(undefined)).toBe(false)
  })
})

describe('isAgentStatusHeldOpenByChildWork', () => {
  it('is true only when a settled lead sits under a row that is not settled', () => {
    expect(isAgentStatusHeldOpenByChildWork({ state: 'working', lead: { state: 'done' } })).toBe(
      true
    )
    expect(isAgentStatusHeldOpenByChildWork({ state: 'done', lead: { state: 'done' } })).toBe(false)
    expect(isAgentStatusHeldOpenByChildWork({ state: 'working', lead: { state: 'working' } })).toBe(
      false
    )
    // No lead fact means no claim: an old host's row is never read as child-held.
    expect(isAgentStatusHeldOpenByChildWork({ state: 'working' })).toBe(false)
  })
})

describe('continueAgentLeadStatus', () => {
  it('keeps the clock across an unchanged state and restarts it on a change', () => {
    const first = continueAgentLeadStatus(undefined, { state: 'working' }, 10)
    expect(first).toEqual({ state: 'working', stateStartedAt: 10 })
    expect(continueAgentLeadStatus(first, { state: 'working' }, 20)).toEqual({
      state: 'working',
      stateStartedAt: 10
    })
    expect(continueAgentLeadStatus(first, { state: 'done', outcome: 'failure' }, 30)).toEqual({
      state: 'done',
      outcome: 'failure',
      stateStartedAt: 30
    })
  })

  it('lets a caller that knows the instant win, and never carries a verdict onto a live state', () => {
    expect(continueAgentLeadStatus(undefined, { state: 'done', stateStartedAt: 4 }, 30)).toEqual({
      state: 'done',
      stateStartedAt: 4
    })
    expect(
      continueAgentLeadStatus(undefined, { state: 'working', outcome: 'cancellation' }, 30)
    ).toEqual({ state: 'working', stateStartedAt: 30 })
  })
})
