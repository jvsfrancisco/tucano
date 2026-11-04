// Google's Antigravity CLI (`agy`), which replaced the Gemini CLI. The engine id stays
// 'gemini' (the models are Gemini's); the binary is `agy`. Its login is not kept in HOME,
// so every turn runs in a throwaway HOME that holds only the Tucano gateway.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { L } from '../../shared/lang'
import { lastLines, num, parseJson, runCli, type Parser } from './cli'
import type { Engine, EngineEvent } from './types'

// Over this, the prompt goes in a file the agent may read: one argument is capped by the OS.
const MAX_PROMPT_ARG = 90_000

export function agyArgs(model: string, prompt: string, settings: object): string[] {
  return ['-p', prompt, '--output-format', 'stream-json', '--model', model, '--settings', JSON.stringify(settings)]
}

// Built-in tools (shell, files, web) are denied; only the Tucano gateway is allowed.
// `readable`: paths it may read (the tool schemas agy writes under HOME, and an oversized prompt).
export function agySettings(web = false, readable: string[] = []) {
  const deny = ['command(*)', 'write_file(*)', 'execute_url(*)', ...(web ? [] : ['read_url(*)']), ...(readable.length ? [] : ['read_file(*)'])]
  return { permissions: { deny, allow: ['mcp(tucano/*)', ...(web ? ['read_url(*)'] : []), ...readable.map((p) => `read_file(${p})`)] } }
}

export const agyMcpConfig = (mcpUrl?: string) => ({ mcpServers: mcpUrl ? { tucano: { disabled: false, serverUrl: mcpUrl } } : {} })

export function geminiParser(): Parser {
  let text = ''
  let finished = false
  return {
    line(line) {
      const ev = parseJson(line)
      if (!ev) return []
      if (ev['event'] === 'step_update') {
        const s = (ev['step_update'] ?? {}) as Record<string, unknown>
        const delta = s['step_type'] === 'agent_response' ? s['text_delta'] : undefined
        if (typeof delta !== 'string' || !delta) return []
        text += delta
        return [{ type: 'text', delta }]
      }
      if (ev['event'] === 'result') {
        finished = true
        const r = (ev['result'] ?? {}) as Record<string, unknown>
        if (String(r['status']).toUpperCase() !== 'SUCCESS') return [{ type: 'error', message: String(r['error'] ?? r['response'] ?? L('O Antigravity terminou com erro.', 'Antigravity ended with an error.')) }]
        const u = (r['usage'] ?? {}) as Record<string, unknown>
        const usage = { inputTokens: num(u['input_tokens']), cacheReadTokens: num(u['cache_read_tokens']), outputTokens: num(u['output_tokens']) }
        return [{ type: 'progress', tokens: usage.inputTokens + usage.outputTokens, cacheRead: usage.cacheReadTokens }, { type: 'done', text: text.trim(), usage }]
      }
      return []
    },
    end(code, stderr) {
      return finished ? [] : [{ type: 'error', message: L(`O Antigravity saiu sem resposta (código ${code ?? '?'}).`, `Antigravity exited without a reply (code ${code ?? '?'}).`) + `\n${lastLines(stderr)}` }]
    }
  }
}

export function geminiEngine(bin: () => string | undefined, environment: NodeJS.ProcessEnv = process.env): Engine {
  return {
    id: 'gemini',
    async *run(turn): AsyncIterable<EngineEvent> {
      const path = bin()
      if (!path) { yield { type: 'error', message: L('O Antigravity CLI (agy) não está instalado.', "Antigravity CLI (agy) isn't installed.") }; return }
      if (turn.images?.length) { yield { type: 'error', message: L('Anexos de imagem ainda não são suportados no Antigravity. Escolha Claude ou Codex para esta tarefa.', 'Image attachments are not supported on Antigravity yet. Choose Claude or Codex for this task.') }; return }
      const dir = mkdtempSync(join(tmpdir(), 'tucano-agy-'))
      try {
        const home = join(dir, 'home')
        mkdirSync(join(home, '.gemini', 'config'), { recursive: true, mode: 0o700 })
        writeFileSync(join(home, '.gemini', 'config', 'mcp_config.json'), JSON.stringify(agyMcpConfig(turn.mcpUrl)), { mode: 0o600 })
        let prompt = `${turn.system}\n\n${turn.prompt}`
        const readable = [join(home, '.gemini', 'antigravity-cli', 'mcp', '**')]
        if (Buffer.byteLength(prompt) > MAX_PROMPT_ARG) {
          const file = join(dir, 'prompt.md')
          writeFileSync(file, prompt, { mode: 0o600 })
          readable.push(file)
          prompt = L(`Leia o arquivo ${file} com a ferramenta de leitura: ele contém suas instruções e a tarefa. Siga-o e responda como se ele fosse esta mensagem.`, `Read the file ${file} with the read tool: it holds your instructions and the task. Follow it and reply as if it were this message.`)
        }
        yield* runCli({ bin: path, args: agyArgs(turn.model, prompt, agySettings(turn.web, readable)), stdin: '', cwd: turn.cwd, signal: turn.signal, parser: geminiParser(), env: { ...environment, HOME: home } })
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }
  }
}
