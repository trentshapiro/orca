import { hasFlag } from './agent-cli-flag-detection'
import { removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentSessionOptionCatalog, CatalogOption } from './agent-session-option-catalog-types'

/**
 * ZCode's collaboration mode is the one launch-time knob its CLI exposes.
 * `normalizePromptMode` (apps/zcode-cli/packages/cli/src/run.ts) accepts exactly these
 * four values and throws on anything else — `auto` exists in the runtime type but is not
 * a valid `--mode` argument, so it is deliberately absent here.
 */
const ZCODE_MODE: CatalogOption = {
  id: 'mode',
  label: 'Collaboration mode',
  category: 'mode',
  kind: {
    type: 'select',
    choices: [
      { value: 'plan', label: 'Plan' },
      { value: 'edit', label: 'Edit' },
      { value: 'build', label: 'Build' },
      { value: 'yolo', label: 'Yolo' }
    ],
    // Why: DefaultRuntimeConfig sets `mode: "build"` for the interactive TUI.
    defaultValue: 'build'
  },
  apply: {
    launchArgs: (value) => ['--mode', String(value)],
    agentArgsOverride: (tokens) => hasFlag(tokens, ['--mode']),
    removeAgentArgs: (tokens) => removeAgentArgOption(tokens, ['--mode'])
  }
}

export const ZCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  supportsWorkerLaunchPreferences: true,
  // Why: ZCode's CLI has no `--model` flag at all (see `parseGlobalArgs`) — the model comes
  // from account config and the in-TUI picker — so there is nothing to seed or apply.
  models: [],
  modelApply: {},
  unknownModelOptions: [ZCODE_MODE]
}
