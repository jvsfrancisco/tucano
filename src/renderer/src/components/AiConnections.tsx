import { useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { addAiConnection, removeAiConnection, loginEngine, refreshEngines, testEngine, useStore, ENGINES, MODELS, type ConnectionEngine } from '../store'
import { ModelPicker } from './Harness'

// Account rows follow the existing harness list, with the same controls and typography.
export function AiConnectionList(): ReactNode {
  const connections = useStore((s) => s.settings.aiConnections ?? [])
  const statuses = useStore((s) => s.settings.connectionStatuses ?? {})
  const agents = useStore((s) => s.agents)
  const [name, setName] = useState('')
  const [engine, setEngine] = useState<ConnectionEngine>('claude')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [manual, setManual] = useState<{ id: string; command: string } | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [model, setModel] = useState('sonnet')
  const [result, setResult] = useState<{ id: string; ok: boolean; message: string } | null>(null)

  async function act(id: string, action: () => Promise<unknown>): Promise<void> {
    setBusy(id)
    setError('')
    try { await action() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }

  return <div className="ai-connections">
    <p className="hint">{L('Dê um nome a cada conta e escolha qual conexão cada agente usa. Os logins acontecem na ferramenta original.', 'Name each account and choose which connection each agent uses. Sign-in happens in the original tool.')}</p>
    <form className="ai-connections__form" onSubmit={(e) => {
      e.preventDefault()
      void act('add', async () => { await addAiConnection(engine, name); setName('') })
    }}>
      <label className="field"><span>{L('Nome da conexão', 'Connection name')}</span><input value={name} maxLength={80} placeholder={L('Ex.: Claude Cauã', 'E.g. Claude Cauã')} onChange={(e) => setName(e.target.value)} required /></label>
      <label className="field"><span>{L('Ferramenta', 'Harness')}</span><select aria-label={L('Ferramenta', 'Harness')} value={engine} onChange={(e) => setEngine(e.target.value as ConnectionEngine)}>{(['claude', 'codex'] as const).map((id) => <option key={id} value={id}>{ENGINES[id].label}</option>)}</select></label>
      <button className="btn btn--primary" disabled={!name.trim() || busy !== null}>{busy === 'add' ? L('Adicionando…', 'Adding…') : L('Adicionar conexão', 'Add connection')}</button>
    </form>
    {error && <p className="note note--error" role="alert">{error}</p>}
    {!connections.length && <p className="muted small">{L('Os agentes usam as conexões padrão da instalação. Adicione uma conta para poder escolhê-la por agente.', 'Agents use the installation’s default connections. Add an account to select it for each agent.')}</p>}
    <div className="harnesses">
      {connections.map((c) => {
        const st = statuses[c.id]
        const used = agents.filter((a) => a.connectionId === c.id)
        return <div className="harness" key={c.id}>
          <div className="harness__head">
            <div className="grow"><strong>{c.name}</strong><span className="harness__account">{ENGINES[c.engine].label} · {st?.loggedIn ? L('Conectada', 'Connected') : L('Falta entrar', 'Not signed in')}</span></div>
            <div className="ai-connections__actions">
              <button className="btn btn--sm" disabled={busy !== null || !st?.installed} onClick={() => void act(c.id, async () => {
                const r = await loginEngine(c.engine, c.id)
                setManual(r.opened ? null : { id: c.id, command: r.command })
              })}>{L('Entrar / trocar conta', 'Sign in / switch account')}</button>
              <button className="btn btn--sm" disabled={busy !== null || !st?.installed} onClick={() => {
                setTesting(testing === c.id ? null : c.id)
                setModel(MODELS.find((m) => m.engine === c.engine)?.id ?? '')
                setResult(null)
              }}>{L('Testar', 'Test')}</button>
              <button className="btn btn--sm btn--ghost" disabled={busy !== null || used.length > 0}
                title={used.length ? L(`Em uso: ${used.map((a) => a.name).join(', ')}`, `In use: ${used.map((a) => a.name).join(', ')}`) : L('Remove a conexão e o login salvo', 'Removes the connection and saved login')}
                onClick={() => { if (confirm(L(`Remover ${c.name} e seu login salvo?`, `Remove ${c.name} and its saved login?`))) void act(c.id, () => removeAiConnection(c.id)) }}
              >{L('Remover', 'Remove')}</button>
            </div>
          </div>
          {!st?.installed && <p className="hint harness__body">{L('Instale a ferramenta na lista acima e clique em Verificar de novo.', 'Install the harness in the list above and click Check again.')}</p>}
          {manual?.id === c.id && <code className="harness__cmd harness__body">{manual.command}</code>}
          {testing === c.id && <div className="harness__body">
            <div className="harness__test">
              <ModelPicker value={model} onChange={setModel} connectionId={c.id} />
              <button className="btn btn--sm" disabled={busy !== null || !model} onClick={() => void act(c.id, async () => {
                setResult(null)
                const r = await testEngine(model, c.id)
                setResult({ id: c.id, ...r })
                refreshEngines()
              })}>{busy === c.id ? L('Testando…', 'Testing…') : L('Mandar teste', 'Send a test')}</button>
            </div>
            {result?.id === c.id && <p className={`note ${result.ok ? 'note--ok' : 'note--error'}`} role="status">{result.message}</p>}
          </div>}
        </div>
      })}
    </div>
    {!!connections.length && <button className="btn btn--sm" onClick={refreshEngines}>{L('Atualizar conexões após o login', 'Refresh connections after sign-in')}</button>}
  </div>
}
