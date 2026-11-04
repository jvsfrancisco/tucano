// Runs the real `agy` once. Off by default: it spends a little of the Google plan.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { geminiEngine } from '../src/core/engines/gemini'

const agy = process.env['TUCANO_LIVE_AGY']

describe.skipIf(!agy)('agy live', () => {
  it('answers a turn with the built-in tools denied', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agy-live-'))
    try {
      const events = []
      for await (const e of geminiEngine(() => agy).run({ model: 'gemini-3.8-flash-low', system: 'Responda em uma palavra.', prompt: 'Diga: pong', cwd, signal: new AbortController().signal } as never)) events.push(e)
      expect(events.find((e) => e.type === 'error')).toBeUndefined()
      expect(events.find((e) => e.type === 'done')).toMatchObject({ type: 'done' })
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  }, 120_000)

  it('follows a prompt too large for one argument, read from a file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agy-live-'))
    try {
      const events = []
      const filler = 'Contexto de enchimento sem importância. '.repeat(3000)
      for await (const e of geminiEngine(() => agy).run({ model: 'gemini-3.8-flash-low', system: 'Responda só com a palavra pedida.', prompt: `${filler}\n\nTAREFA: responda exatamente a palavra TUCANO.`, cwd, signal: new AbortController().signal } as never)) events.push(e)
      expect(events.find((e) => e.type === 'error')).toBeUndefined()
      expect(events.find((e) => e.type === 'done')).toMatchObject({ type: 'done', text: expect.stringContaining('TUCANO') })
    } finally { rmSync(cwd, { recursive: true, force: true }) }
  }, 120_000)
})
