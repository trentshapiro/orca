import { describe, expect, it } from 'vitest'
import {
  continueAgentLeadStatus,
  foldAgentLeadStatus,
  isAgentStatusHeldOpenByChildWork
} from './agent-lead-status-fold'

describe('foldAgentLeadStatus', () => {
  it('keeps a lead that is not settled, whatever its children do', () => {
    expect(foldAgentLeadStatus({ leadState: 'blocked', childWorkLiveness: 'working' })).toEqual({
      stateName: 'blocked'
    })
  })

  it('reads a settled lead with live agent work as working', () => {
    expect(foldAgentLeadStatus({ leadState: 'done', childWorkLiveness: 'working' })).toEqual({
      stateName: 'working'
    })
  })

  it('reads a settled lead with only watch loops as monitoring', () => {
    expect(foldAgentLeadStatus({ leadState: 'done', childWorkLiveness: 'monitoring' })).toEqual({
      stateName: 'working',
      workingMode: 'monitoring'
    })
  })

  it("takes no verdict: how the lead's turn ended is not a fold input", () => {
    // A cancel is a fact about the lead, carried on `lead.outcome`; the work it left running
    // reads exactly as it would after a plain end of turn.
    const input: Parameters<typeof foldAgentLeadStatus>[0] = {
      leadState: 'done',
      childWorkLiveness: 'monitoring'
    }
    expect(Object.keys(input)).toEqual(['leadState', 'childWorkLiveness'])
    expect(foldAgentLeadStatus(input)).toEqual({ stateName: 'working', workingMode: 'monitoring' })
  })

  it('settles when nothing is running', () => {
    expect(foldAgentLeadStatus({ leadState: 'done', childWorkLiveness: null })).toEqual({
      stateName: 'done'
    })
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
