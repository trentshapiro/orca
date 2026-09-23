// One story table driven through every lane that publishes a lead agent's status. Each lane
// derives child liveness from its own evidence, but the published `{ state, workingMode, lead }`
// must be what the shared fold says for that lead and that evidence — a producer that folds
// differently is caught here structurally, not by review.
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import { markClaudeLeadTurnInterrupted } from './agent-hook-listener/providers/claude-roster-state'
import { markCodexLeadTurnInterrupted } from './agent-hook-listener/providers/codex-state'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'
import { foldAgentLeadStatus } from './agent-lead-status-fold'
import type { AgentSessionBackgroundTask } from './agent-session-background-task-wire'
import {
  agentChildWorkLiveness,
  agentChildWorkLivenessFromEvidence,
  type AgentChildWorkLiveness
} from './agent-status-child-work-liveness'
import type {
  AgentLeadStatus,
  AgentStatusState,
  AgentWorkingMode,
  ParsedAgentStatusPayload
} from './agent-status-types'
import { codexRosterChildWorkLiveness, seedCodexSubagentRoster } from './codex-subagent-roster'
import { structuredAgentSessionAgentStatus } from './structured-agent-session-agent-status'
import type { AgentJournalTurnOutcome } from './agent-turn-outcome'

type Published = {
  state: AgentStatusState
  workingMode?: AgentWorkingMode
  lead: Omit<AgentLeadStatus, 'stateStartedAt'>
}

const RUNNING_SHELL = { id: 'shell-1', type: 'shell', status: 'running' }
/** Not a hook: current Claude sends none on a cancel, so Orca infers it from the keystroke. */
const ORCA_INFERRED_INTERRUPT = { orca_inferred_interrupt: true }
const RUNNING_AGENT = { id: 'agent-1', type: 'subagent', status: 'running' }
const AGENT_TASK: AgentSessionBackgroundTask = { id: 'agent-1', kind: 'agent', state: 'working' }
const SHELL_TASK: AgentSessionBackgroundTask = { id: 'shell-1', kind: 'command', state: 'working' }

function published(payload: ParsedAgentStatusPayload | null | undefined): Published {
  if (!payload?.lead) {
    throw new Error('the lane published no lead fact')
  }
  const { stateStartedAt: _clock, ...lead } = payload.lead
  return {
    state: payload.state,
    ...(payload.workingMode ? { workingMode: payload.workingMode } : {}),
    lead
  }
}

/** The lead's own state and verdict, restated as the fold's inputs. */
function refold(lead: Published['lead'], childWorkLiveness: AgentChildWorkLiveness): Published {
  const resolution = foldAgentLeadStatus({
    leadState: lead.state,
    interrupted: lead.outcome === 'cancellation',
    childWorkLiveness
  })
  return {
    state: resolution.stateName,
    ...(resolution.workingMode ? { workingMode: resolution.workingMode } : {}),
    lead
  }
}

type Story = {
  name: string
  claude?: { events: Record<string, unknown>[]; expect: Published }
  structured?: {
    status: 'working' | 'attention' | 'idle'
    backgroundTasks?: AgentSessionBackgroundTask[]
    turnOutcome?: AgentJournalTurnOutcome
    expect: Published
  }
  grok?: { events: Record<string, unknown>[]; expect: Published }
  codex?: { events: Record<string, unknown>[]; expect: Published }
}

const STORIES: Story[] = [
  {
    name: 'main agent working',
    claude: {
      events: [{ hook_event_name: 'UserPromptSubmit', prompt: 'go' }],
      expect: { state: 'working', lead: { state: 'working' } }
    },
    structured: { status: 'working', expect: { state: 'working', lead: { state: 'working' } } },
    grok: {
      events: [{ hookEventName: 'user_prompt_submit', prompt: 'go' }],
      expect: { state: 'working', lead: { state: 'working' } }
    },
    codex: {
      events: [{ hook_event_name: 'UserPromptSubmit', prompt: 'go' }],
      expect: { state: 'working', lead: { state: 'working' } }
    }
  },
  {
    name: 'done with a live subagent',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'Stop', background_tasks: [RUNNING_AGENT] }
      ],
      expect: { state: 'working', lead: { state: 'done' } }
    },
    structured: {
      status: 'idle',
      backgroundTasks: [AGENT_TASK],
      expect: { state: 'working', lead: { state: 'done' } }
    },
    grok: {
      events: [
        { hookEventName: 'user_prompt_submit', prompt: 'go' },
        { hookEventName: 'stop', reason: 'end_turn', backgroundTasks: [RUNNING_AGENT] }
      ],
      // Grok reports no task kind the roster can classify as agent work, so its live subagent
      // reads as watch work. Today's label, kept on purpose; a Grok-specific follow-up.
      expect: { state: 'working', workingMode: 'monitoring', lead: { state: 'done' } }
    },
    codex: {
      // A root Stop with no transcript-tracked children clears the roster (Codex 0.144 could omit
      // child Stop hooks), so the child proves it is still alive with its next tool event.
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'Stop' },
        { hook_event_name: 'PreToolUse', agent_id: 'agent-1', tool_name: 'shell' }
      ],
      expect: { state: 'working', lead: { state: 'done' } }
    }
  },
  {
    name: 'done with only a watch loop',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] }
      ],
      expect: { state: 'working', workingMode: 'monitoring', lead: { state: 'done' } }
    },
    structured: {
      status: 'idle',
      backgroundTasks: [SHELL_TASK],
      expect: { state: 'working', workingMode: 'monitoring', lead: { state: 'done' } }
    },
    grok: {
      events: [
        { hookEventName: 'user_prompt_submit', prompt: 'go' },
        { hookEventName: 'stop', reason: 'end_turn', backgroundTasks: [RUNNING_SHELL] }
      ],
      expect: { state: 'working', workingMode: 'monitoring', lead: { state: 'done' } }
    }
  },
  {
    name: 'blocked with a live subagent',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm' } }
      ],
      // The hook lane's vocabulary for "the lead needs a human" is `waiting`.
      expect: { state: 'waiting', lead: { state: 'waiting' } }
    },
    structured: {
      status: 'attention',
      backgroundTasks: [AGENT_TASK],
      expect: { state: 'blocked', lead: { state: 'blocked' } }
    },
    grok: {
      events: [
        { hookEventName: 'user_prompt_submit', prompt: 'go' },
        { hookEventName: 'pre_tool_use', toolName: 'ask_user_question' }
      ],
      expect: { state: 'waiting', lead: { state: 'waiting' } }
    },
    codex: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'PermissionRequest', tool_name: 'shell' }
      ],
      expect: { state: 'waiting', lead: { state: 'waiting' } }
    }
  },
  {
    // KNOWN DIVERGENCE in the lead fact, pinned on purpose. The Claude hook lane records a
    // child's permission wait by displacing the lead record (`waitingAgentId`, `stateBeforeWait`),
    // so its published `lead.state` reads `waiting` while the lead is really still working. Codex
    // keeps the wait on the child and its `lead` stays the root's own state; the fold's
    // waiting-child input surfaces it. Moving Claude onto the child fact flips its rows here.
    name: 'a child blocked on the user (known divergence: Claude displaces the lead record)',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        {
          hook_event_name: 'PermissionRequest',
          agent_id: 'agent-1',
          tool_name: 'Bash',
          tool_input: { command: 'rm' }
        }
      ],
      expect: { state: 'waiting', lead: { state: 'waiting' } }
    },
    codex: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'PermissionRequest', agent_id: 'agent-1', tool_name: 'shell' }
      ],
      expect: { state: 'waiting', lead: { state: 'working' } }
    }
  },
  {
    name: 'settled lead whose child is blocked on the user (same known divergence)',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'Stop', background_tasks: [RUNNING_AGENT] },
        {
          hook_event_name: 'PermissionRequest',
          agent_id: 'agent-1',
          tool_name: 'Bash',
          tool_input: { command: 'rm' }
        }
      ],
      expect: { state: 'waiting', lead: { state: 'waiting' } }
    },
    structured: {
      status: 'idle',
      backgroundTasks: [{ ...AGENT_TASK, state: 'waiting' }],
      expect: { state: 'waiting', lead: { state: 'done' } }
    },
    codex: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'Stop' },
        { hook_event_name: 'PermissionRequest', agent_id: 'agent-1', tool_name: 'shell' }
      ],
      expect: { state: 'waiting', lead: { state: 'done' } }
    }
  },
  {
    name: 'failed turn',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'StopFailure', error: 'invalid_request' }
      ],
      expect: { state: 'done', lead: { state: 'done', outcome: 'failure' } }
    },
    structured: {
      status: 'idle',
      turnOutcome: 'failure',
      expect: { state: 'done', lead: { state: 'done', outcome: 'failure' } }
    },
    grok: {
      events: [
        { hookEventName: 'user_prompt_submit', prompt: 'go' },
        { hookEventName: 'stop_failure' }
      ],
      expect: { state: 'done', lead: { state: 'done', outcome: 'failure' } }
    }
  },
  {
    // KNOWN DIVERGENCE, pinned on purpose. The hook lane hides a still-running shell after an
    // interrupted turn; the structured lane never feeds the verdict into the fold and keeps
    // showing the shell. The cancel policy (PR C) flips the hook-lane rows to monitoring and
    // must update this story, not delete it. The Claude row here is the primary path: Orca's
    // inferred cancel, carried by the lead record into the next Stop, which lists the shell.
    name: 'interrupted with a watch loop (known divergence: CLI done / structured monitoring)',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        ORCA_INFERRED_INTERRUPT,
        { hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] }
      ],
      expect: { state: 'done', lead: { state: 'done', outcome: 'cancellation' } }
    },
    structured: {
      status: 'idle',
      turnOutcome: 'cancellation',
      backgroundTasks: [SHELL_TASK],
      expect: {
        state: 'working',
        workingMode: 'monitoring',
        lead: { state: 'done', outcome: 'cancellation' }
      }
    },
    grok: {
      events: [
        { hookEventName: 'user_prompt_submit', prompt: 'go' },
        { hookEventName: 'stop_cancelled', backgroundTasks: [RUNNING_SHELL] }
      ],
      expect: { state: 'done', lead: { state: 'done', outcome: 'cancellation' } }
    }
  },
  {
    // Neither CLI reports a cancel on its own Stop, so the late turn boundary must keep the
    // verdict Orca inferred rather than downgrade it to "unknown".
    name: 'interrupted, then the late turn boundary',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        ORCA_INFERRED_INTERRUPT,
        { hook_event_name: 'Stop' }
      ],
      expect: { state: 'done', lead: { state: 'done', outcome: 'cancellation' } }
    },
    codex: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        ORCA_INFERRED_INTERRUPT,
        { hook_event_name: 'Stop' }
      ],
      expect: { state: 'done', lead: { state: 'done', outcome: 'cancellation' } }
    }
  },
  {
    // Secondary source: a build that does send `is_interrupt` on its Stop. Same known divergence.
    name: 'interrupted by a Stop that carries is_interrupt, with a watch loop (older builds)',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'Stop', is_interrupt: true, background_tasks: [RUNNING_SHELL] }
      ],
      expect: { state: 'done', lead: { state: 'done', outcome: 'cancellation' } }
    }
  }
]

/** The stories a lane takes part in, as `it.each` rows. */
function storiesFor<K extends 'claude' | 'structured' | 'grok' | 'codex'>(
  lane: K
): [string, NonNullable<Story[K]>][] {
  const rows: [string, NonNullable<Story[K]>][] = []
  for (const story of STORIES) {
    const entry = story[lane]
    if (entry !== undefined) {
      rows.push([story.name, entry])
    }
  }
  return rows
}

describe('lead status parity across lanes', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function drive(
    source: 'claude' | 'grok' | 'codex',
    events: Record<string, unknown>[]
  ): ParsedAgentStatusPayload {
    let last: ParsedAgentStatusPayload | null = null
    for (const payload of events) {
      if (payload === ORCA_INFERRED_INTERRUPT) {
        if (source === 'codex') {
          markCodexLeadTurnInterrupted(state, PANE_KEY)
        } else {
          markClaudeLeadTurnInterrupted(state, PANE_KEY)
        }
        continue
      }
      const event = normalizeHookPayload(
        state,
        source,
        { paneKey: PANE_KEY, payload },
        'production'
      )
      last = event?.payload ?? last
    }
    if (!last) {
      throw new Error('the lane published nothing')
    }
    return last
  }

  /** The hook lane's child evidence: the roster on the row, the shell and cron sets in memory. */
  function claudeChildWorkLiveness(payload: ParsedAgentStatusPayload): AgentChildWorkLiveness {
    return agentChildWorkLivenessFromEvidence({
      // The roster never carries a wait: this lane displaces the lead record instead.
      hasWaitingChildWork: false,
      hasLiveAgentWork: payload.subagents?.some((child) => child.state === 'working') === true,
      hasLiveNonAgentWork:
        state.claudeRunningNonAgentTaskPaneKeys.has(PANE_KEY) ||
        state.claudeActiveSessionCronPaneKeys.has(PANE_KEY)
    })
  }

  describe('Claude hook lane', () => {
    it.each(storiesFor('claude'))('%s', (_name, lane) => {
      const payload = drive('claude', lane.events)
      const row = published(payload)
      expect(row).toEqual(lane.expect)
      expect(row).toEqual(refold(row.lead, claudeChildWorkLiveness(payload)))
    })
  })

  describe('structured lane', () => {
    it.each(storiesFor('structured'))('%s', (_name, lane) => {
      const row = structuredAgentSessionAgentStatus({
        status: lane.status,
        backgroundTasks: lane.backgroundTasks,
        turnOutcome: lane.turnOutcome
      })
      expect(row).toEqual(lane.expect)
      // This lane never feeds the verdict into the fold: refold with the verdict masked.
      const masked = { state: row.lead.state }
      expect(refold(masked, agentChildWorkLiveness(lane.backgroundTasks))).toEqual({
        ...row,
        lead: masked
      })
    })
  })

  describe('Grok hook lane', () => {
    it.each(storiesFor('grok'))('%s', (_name, lane) => {
      const payload = drive('grok', lane.events)
      const row = published(payload)
      expect(row).toEqual(lane.expect)
      // Grok's child evidence lives only on its final plain `stop`: a finite task or an active
      // stop hook is watch work, and nothing else ever holds the pane.
      const last = lane.events.at(-1) ?? {}
      const tasks = Array.isArray(last.backgroundTasks) ? last.backgroundTasks : []
      const liveness: AgentChildWorkLiveness =
        last.hookEventName === 'stop' && (tasks.length > 0 || last.stopHookActive === true)
          ? 'monitoring'
          : null
      expect(row).toEqual(refold(row.lead, liveness))
    })
  })

  describe('Codex hook lane', () => {
    it.each(storiesFor('codex'))('%s', (_name, lane) => {
      const payload = drive('codex', lane.events)
      const row = published(payload)
      expect(row).toEqual(lane.expect)
      // Codex's child evidence is the roster on the row: every child a spawned agent thread.
      const roster = new Map()
      seedCodexSubagentRoster(roster, payload.subagents ?? [])
      expect(row).toEqual(refold(row.lead, codexRosterChildWorkLiveness(roster)))
    })
  })
})
