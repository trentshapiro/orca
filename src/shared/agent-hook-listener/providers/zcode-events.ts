import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import {
  resolvePrompt,
  resolveToolState,
  shouldIgnoreCompactContinuationUserPromptSubmit
} from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

// Why: ZCode's own lifecycle events are camelCase, but its hook runner writes a
// Claude-compatible stdin alias set (`hook_event_name`, `tool_name`, `tool_input`,
// `transcript_path`, `last_assistant_message`) alongside them — see ZCode's
// `packages/core/src/hooks/configured-runner-input.ts`. Orca reads the aliases, so the
// Claude tool-field extractor applies verbatim; only the agent identity differs.
const ZCODE_IDLE_SESSION_START_SOURCES: ReadonlySet<string> = new Set([
  'startup',
  'resume',
  'clear'
])

export function normalizeZCodeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }

  const toolName = readString(hookPayload, 'tool_name')
  // Why: ZCode's clarification tool is literally `AskUserQuestion` with Claude's
  // questions/options input shape, so Orca's question card renders it unchanged.
  const isUserInputTool = isAskUserQuestionTool(toolName)

  let stateName: 'working' | 'waiting' | 'done' | null = null
  let sessionBoundary = false
  switch (eventName) {
    case 'SessionStart': {
      // Why: land a resumed/started session as an idle boundary row, not a phantom spinner;
      // `compact` fires mid-turn, so anything outside the idle allowlist is dropped.
      const source = hookPayload['source']
      if (typeof source !== 'string' || !ZCODE_IDLE_SESSION_START_SOURCES.has(source)) {
        return null
      }
      stateName = 'done'
      sessionBoundary = true
      break
    }
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      stateName = 'working'
      break
    case 'PreToolUse':
      stateName = isUserInputTool ? 'waiting' : 'working'
      break
    case 'PermissionRequest':
      // Why: ZCode fires this only once the approval card is already on screen and racing the
      // user's answer (`packages/core/src/tool/executor/permission-flow.ts`), never for an
      // auto-approved call — so it is proof the pane is blocked on a human.
      stateName = 'waiting'
      break
    case 'Stop':
      stateName = 'done'
      break
    default:
      return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('zcode', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('zcode', eventName) }
  )

  const interrupted =
    eventName === 'Stop' && hookPayload['is_interrupt'] === true ? true : undefined

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('zcode', eventName)
    }),
    agentType: 'zcode',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    ...(sessionBoundary ? { sessionBoundary: true } : {}),
    interrupted
  })
}
