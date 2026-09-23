import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import {
  AGENT_SESSION_MIRROR_LIMIT,
  AgentSessionTransitionRecorder,
  classifyAgentSessionTransition
} from './agent-session-transition-recorder'
import type { AgentSessionSink, AgentSessionStatusEvent } from './agent-session-transition-recorder'
import { StatsCollector } from './collector'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

const T = 1_700_000_000_000
const PANE = 'tab-1:pane-1'

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-stats-recorder-'))
  vi.useFakeTimers({ now: T })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(userDataDir, { recursive: true, force: true })
})

function hook(
  state: AgentSessionStatusEvent['payload']['state'],
  stateStartedAt: number,
  extra: Partial<AgentSessionStatusEvent> = {}
): AgentSessionStatusEvent {
  return {
    paneKey: PANE,
    connectionId: null,
    stateStartedAt,
    receivedAt: stateStartedAt,
    payload: { state },
    ...extra
  }
}

/** A row from a host that publishes the lead fact beside the combined state. */
function leadHook(
  row: {
    state: AgentSessionStatusEvent['payload']['state']
    workingMode?: 'monitoring'
    lead: { state: AgentSessionStatusEvent['payload']['state']; stateStartedAt: number }
  },
  stateStartedAt: number,
  extra: Partial<AgentSessionStatusEvent> = {}
): AgentSessionStatusEvent {
  return hook(row.state, stateStartedAt, {
    payload: { state: row.state, workingMode: row.workingMode, lead: row.lead },
    ...extra
  })
}

function sink(): AgentSessionSink & {
  onAgentStart: Mock<AgentSessionSink['onAgentStart']>
  onAgentStop: Mock<AgentSessionSink['onAgentStop']>
} {
  return {
    onAgentStart: vi.fn<AgentSessionSink['onAgentStart']>(),
    onAgentStop: vi.fn<AgentSessionSink['onAgentStop']>()
  }
}

describe('AgentSessionTransitionRecorder', () => {
  it('counts a hook-only agent that never writes an agent-shaped terminal title', () => {
    // The regression this replaces: stats read OSC titles, so an agent whose CLI
    // reports only over hooks contributed nothing to either aggregate (#10201).
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    recorder.onStatus(hook('done', T + 180_000))

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(180_000)
  })

  it('does not double-count a replayed status on reconnect', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    // Warm reconnect: the pane is already mirrored, so the replays are snapshots.
    recorder.onStatus(hook('working', T, { isReplay: true }))
    recorder.onStatus(hook('working', T, { isReplay: true }))
    recorder.onStatus(hook('working', T, { isReplay: true }))
    // Cold reconnect (app restart / new relay session): the replay is the first
    // thing this recorder sees for the pane, so the snapshot guard cannot help —
    // only the live gate stops it counting work that began in an earlier runtime.
    recorder.onStatus(hook('working', T, { paneKey: 'cold-pane', isReplay: true }))
    recorder.onStatus(hook('working', T, { paneKey: 'cold-pane', isReplay: true }))

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
  })

  it('does not double-count a re-emitted live status mid-turn', () => {
    // Tool-progress events re-emit `working` many times per turn.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    for (let i = 0; i < 25; i++) {
      recorder.onStatus(hook('working', T))
    }
    recorder.onStatus(hook('done', T + 5_000))

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(5_000)
  })

  it('never opens a session from a replayed or disk-restored working status', () => {
    // A replayed `working` describes work that began in an earlier runtime;
    // crediting it would mint a phantom spawn on every reconnect.
    const replayed = sink()
    new AgentSessionTransitionRecorder(replayed).onStatus(hook('working', T, { isReplay: true }))
    expect(replayed.onAgentStart).not.toHaveBeenCalled()

    const restored = sink()
    new AgentSessionTransitionRecorder(restored).onStatus(
      hook('working', T, { restoredUnconfirmed: true })
    )
    expect(restored.onAgentStart).not.toHaveBeenCalled()
  })

  it('still closes a live session when the terminating status arrives as a replay', () => {
    // How a client learns about a completion it missed while disconnected.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    recorder.onStatus(hook('done', T + 30_000, { isReplay: true }))

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(30_000)
  })

  it('counts one session per turn across repeated working/done cycles', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    recorder.onStatus(hook('done', T + 10_000))
    recorder.onStatus(hook('working', T + 60_000))
    recorder.onStatus(hook('done', T + 75_000))

    expect(stats.getSummary().totalAgentsSpawned).toBe(2)
    expect(stats.getSummary().totalAgentTimeMs).toBe(25_000)
  })

  it('treats waiting and blocked as session boundaries, not agent work', () => {
    // Time parked on a permission prompt is the user's, not the agent's.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    recorder.onStatus(hook('waiting', T + 5_000))
    recorder.onStatus(hook('working', T + 300_000))
    recorder.onStatus(hook('blocked', T + 310_000))

    expect(stats.getSummary().totalAgentsSpawned).toBe(2)
    expect(stats.getSummary().totalAgentTimeMs).toBe(15_000)
  })

  it('ignores identity-only provider-session refreshes', () => {
    // These carry a state field but no turn-state transition; acting on them
    // would open a session from a resume-metadata write.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T, { providerSessionOnly: true }))
    expect(stats.getSummary().totalAgentsSpawned).toBe(0)

    recorder.onStatus(hook('working', T + 1_000))
    recorder.onStatus(hook('done', T + 2_000, { providerSessionOnly: true }))
    // The refresh must not close the live session either.
    expect(stats.getSummary().totalAgentTimeMs).toBe(0)

    recorder.onStatus(hook('done', T + 3_000))
    expect(stats.getSummary().totalAgentTimeMs).toBe(2_000)
  })

  it('closes an open session when its pane is torn down', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    vi.setSystemTime(T + 45_000)
    recorder.onCleared({ paneKey: PANE })

    expect(stats.getSummary().totalAgentTimeMs).toBe(45_000)
    expect(recorder.trackedPaneCount).toBe(0)
  })

  it('closes sessions on the dropped connection when an SSH batch clear lands', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T, { paneKey: 'a', connectionId: 'ssh-1' }))
    recorder.onStatus(hook('working', T, { paneKey: 'b', connectionId: 'ssh-2' }))
    recorder.onCleared({ transient: true, connectionId: 'ssh-1', clearedAt: T + 20_000 })

    expect(stats.getSummary().totalAgentTimeMs).toBe(20_000)
    expect(recorder.trackedPaneCount).toBe(1)
  })

  it('bounds the mirror and closes what it evicts', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T, { paneKey: 'oldest' }))
    for (let i = 0; i < AGENT_SESSION_MIRROR_LIMIT; i++) {
      recorder.onStatus(hook('working', T, { paneKey: `pane-${i}` }))
    }

    expect(recorder.trackedPaneCount).toBe(AGENT_SESSION_MIRROR_LIMIT)
    // The evicted pane's open session was closed out rather than leaked.
    expect(stats.getSummary().totalAgentsSpawned).toBe(AGENT_SESSION_MIRROR_LIMIT + 1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(0)
  })
})

describe('AgentSessionTransitionRecorder reading the lead fact', () => {
  // The stats ask "was an agent executing": the lead's own turn, or a subagent still running
  // after the lead settled. A background shell the settled lead left behind is neither.
  const LEAD_WORKING = { state: 'working' as const, stateStartedAt: T }

  it('stops the session when the lead settles and only a watch loop holds the row working', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(leadHook({ state: 'working', lead: LEAD_WORKING }, T))
    // The Stop hook: the row stays `working` (same clock) in monitoring mode; the lead is done.
    recorder.onStatus(
      leadHook(
        {
          state: 'working',
          workingMode: 'monitoring',
          lead: { state: 'done', stateStartedAt: T + 20_000 }
        },
        T,
        { receivedAt: T + 20_000 }
      )
    )
    // Hours of dev server later, the shell exits and the row settles.
    recorder.onStatus(
      leadHook(
        { state: 'done', lead: { state: 'done', stateStartedAt: T + 20_000 } },
        T + 7_200_000
      )
    )

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(20_000)
  })

  it('keeps the session open while a subagent outlives the lead, and closes it when the child settles', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(leadHook({ state: 'working', lead: LEAD_WORKING }, T))
    recorder.onStatus(
      leadHook({ state: 'working', lead: { state: 'done', stateStartedAt: T + 10_000 } }, T)
    )
    recorder.onStatus(
      leadHook({ state: 'done', lead: { state: 'done', stateStartedAt: T + 10_000 } }, T + 90_000)
    )

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(90_000)
  })

  it('dates the stop by the evidence when a shell outlives the last subagent', () => {
    // Lead done at +10s, its subagent finishes at +60s, a shell keeps the row in monitoring:
    // neither state clock moves at +60s, so the evidence clock is the edge.
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)
    const leadDone = { state: 'done' as const, stateStartedAt: T + 10_000 }

    recorder.onStatus(leadHook({ state: 'working', lead: LEAD_WORKING }, T))
    recorder.onStatus(leadHook({ state: 'working', lead: leadDone }, T))
    recorder.onStatus(
      leadHook({ state: 'working', workingMode: 'monitoring', lead: leadDone }, T, {
        receivedAt: T + 60_000
      })
    )

    expect(stats.getSummary().totalAgentTimeMs).toBe(60_000)
  })

  it('opens a new session dated by the lead clock when the lead resumes after monitoring', () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(leadHook({ state: 'working', lead: LEAD_WORKING }, T))
    recorder.onStatus(
      leadHook(
        {
          state: 'working',
          workingMode: 'monitoring',
          lead: { state: 'done', stateStartedAt: T + 5_000 }
        },
        T,
        { receivedAt: T + 5_000 }
      )
    )
    // A task notification resumes the lead; the row's own clock never moved off T.
    recorder.onStatus(
      leadHook({ state: 'working', lead: { state: 'working', stateStartedAt: T + 300_000 } }, T)
    )
    recorder.onStatus(
      leadHook({ state: 'done', lead: { state: 'done', stateStartedAt: T + 312_000 } }, T + 312_000)
    )

    expect(stats.getSummary().totalAgentsSpawned).toBe(2)
    expect(stats.getSummary().totalAgentTimeMs).toBe(17_000)
  })

  it('never opens a session from a restored row whose lead reads working', () => {
    const restored = sink()
    new AgentSessionTransitionRecorder(restored).onStatus(
      leadHook({ state: 'working', lead: LEAD_WORKING }, T, { restoredUnconfirmed: true })
    )
    expect(restored.onAgentStart).not.toHaveBeenCalled()

    const replayed = sink()
    new AgentSessionTransitionRecorder(replayed).onStatus(
      leadHook({ state: 'working', lead: LEAD_WORKING }, T, { isReplay: true })
    )
    expect(replayed.onAgentStart).not.toHaveBeenCalled()
  })

  it("reads an old host's monitoring row exactly as before: working holds the session open", () => {
    const stats = new StatsCollector()
    const recorder = new AgentSessionTransitionRecorder(stats)

    recorder.onStatus(hook('working', T))
    recorder.onStatus(
      hook('working', T, { payload: { state: 'working', workingMode: 'monitoring' } })
    )
    recorder.onStatus(hook('done', T + 40_000))

    expect(stats.getSummary().totalAgentsSpawned).toBe(1)
    expect(stats.getSummary().totalAgentTimeMs).toBe(40_000)
  })
})

describe('classifyAgentSessionTransition', () => {
  it('treats an unchanged answer as a snapshot, never a transition', () => {
    expect(
      classifyAgentSessionTransition({ executing: true, open: true }, hook('working', T))
    ).toBe('none')
    expect(classifyAgentSessionTransition({ executing: false, open: false }, hook('done', T))).toBe(
      'none'
    )
  })

  it('opens only on a live working edge', () => {
    expect(classifyAgentSessionTransition(undefined, hook('working', T))).toBe('start')
    expect(classifyAgentSessionTransition(undefined, hook('working', T, { isReplay: true }))).toBe(
      'none'
    )
  })

  it('closes only a session it opened', () => {
    expect(classifyAgentSessionTransition({ executing: true, open: true }, hook('done', T))).toBe(
      'stop'
    )
    expect(classifyAgentSessionTransition({ executing: true, open: false }, hook('done', T))).toBe(
      'none'
    )
  })
})
