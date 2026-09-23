import { readFileSync } from 'node:fs'
import { applyEdits, modify, parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { isPlainObject } from '../agent-hooks/installer-utils'
import { isZCodeHooksEnabled, type ZCodeConfig } from './hook-settings'

export type ZCodeConfigSource = {
  text: string | null
  config: ZCodeConfig
}

export function parseZCodeConfigText(text: string, diagnosticName: string): ZCodeConfig | null {
  const errors: ParseError[] = []
  const parsed = parseJsonc(text, errors)
  if (errors.length > 0) {
    console.warn(
      `Could not parse ${diagnosticName}: ${errors.map((e) => `offset ${e.offset} length ${e.length}`).join(', ')}`
    )
    return null
  }
  if (parsed === undefined) {
    return {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: isPlainObject just proved this is a plain object; ZCodeConfig only adds optional keys over its index signature.
  return isPlainObject(parsed) ? (parsed as ZCodeConfig) : null
}

/** Original file text alongside its parsed form, so a write can edit the text in place. */
export function readZCodeConfigSource(configPath: string): ZCodeConfigSource | null {
  let text: string
  try {
    text = readFileSync(configPath, 'utf-8')
  } catch (error) {
    // Why: only a definitive "no such file" is a fresh install; an EACCES/EIO must not
    // be mistaken for one and overwrite the user's config with a stub.
    return isDefinitiveAbsence(error) ? { text: null, config: {} } : null
  }
  const config = parseZCodeConfigText(text, 'ZCode config.json')
  return config === null ? null : { text, config }
}

/** The `hooks.events` block as a plain lookup, or empty when absent or malformed. */
function readEventMap(config: ZCodeConfig): Record<string, unknown> {
  const events = config.hooks?.events
  return isPlainObject(events) ? events : {}
}

/**
 * Serialize by editing the original text one hook event at a time, so the user's comments,
 * key order, and formatting survive. A parse -> JSON.stringify round trip would drop them.
 */
export function serializeZCodeConfig(originalText: string | null, nextConfig: ZCodeConfig): string {
  if (originalText === null) {
    return `${JSON.stringify(nextConfig, null, 2)}\n`
  }

  const previous = parseZCodeConfigText(originalText, 'ZCode config.json') ?? {}
  const previousEvents = readEventMap(previous)
  const nextEvents = readEventMap(nextConfig)

  let text = originalText
  const nextEnabled = isZCodeHooksEnabled(nextConfig)
  if (isZCodeHooksEnabled(previous) !== nextEnabled) {
    text = applyEdits(
      text,
      modify(text, ['hooks', 'enabled'], nextEnabled, {
        formattingOptions: { insertSpaces: true, tabSize: 2 }
      })
    )
  }
  // Why: touch only the events that actually changed, so the user's key order and
  // indentation around their own untouched hook entries stay put.
  for (const eventName of new Set([...Object.keys(previousEvents), ...Object.keys(nextEvents)])) {
    const nextValue = nextEvents[eventName]
    if (JSON.stringify(previousEvents[eventName]) === JSON.stringify(nextValue)) {
      continue
    }
    text = applyEdits(
      text,
      // Why: `undefined` removes the key, which is how remove() drops an emptied event.
      modify(text, ['hooks', 'events', eventName], nextValue, {
        formattingOptions: { insertSpaces: true, tabSize: 2 }
      })
    )
  }
  return text
}
