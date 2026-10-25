import { app } from 'electron'
import { buildSayTeamCommand } from '../services/input/console-send'
import { translateReply } from '../services/session/durable-translator'
import { loadSettings } from '../services/settings'

const DRAFT = '中路插个眼，小心他们开雾'

/** Reply draft -> translation -> say_team command. Keystrokes are never sent here. */
export async function runInputProbe(): Promise<void> {
  const settings = loadSettings()
  let translated: string | null = null
  let translateError: string | null = null

  try {
    translated = await translateReply(settings.provider, DRAFT, settings.replyTone)
  } catch (err) {
    translateError = err instanceof Error ? err.message : String(err)
  }

  const command = translated ? buildSayTeamCommand(translated) : null
  const cleaned = buildSayTeamCommand('say "hi"   we  are')
  const result = {
    ok:
      Boolean(translated && /[a-zA-Z]/.test(translated)) &&
      Boolean(command && command.startsWith('say_team "') && command.endsWith('"')) &&
      cleaned === 'say_team "say hi we are"',
    draft: DRAFT,
    translated,
    command,
    cleaned,
    translateError
  }
  console.log('INPUT_PROBE', JSON.stringify(result))
  app.exit(result.ok ? 0 : 1)
}
