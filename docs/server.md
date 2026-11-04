# Tucano sem janela (servidor)

O mesmo núcleo do app, rodando em Node puro, acessado por um navegador. Serve para deixar o Tucano
numa máquina ligada o tempo todo e entrar de qualquer lugar.

```sh
npm run build                                   # gera out/main/server.js e out/renderer
node out/main/server.js user add João           # cria (ou troca a senha de) uma pessoa
node out/main/server.js user add Cauã
node out/main/server.js                         # sobe em http://127.0.0.1:8787
```

Variáveis: `TUCANO_DATA` (pasta de dados, padrão `~/.tucano-server`), `TUCANO_HOST` (padrão
`127.0.0.1`), `TUCANO_PORT` (padrão `8787`), `TUCANO_SECURE=1` (atrás de HTTPS), `TUCANO_PASSWORD`
(senha sem prompt, para scripts), `TUCANO_SECRET_KEY` (chave dos segredos, em vez do arquivo).

## Como funciona

- O núcleo (`src/core`) não mudou. Dentro do Electron ele fala com o processo principal pelo
  `process.parentPort`; no servidor, `src/core/host.ts` (`HeadlessParent`) responde no lugar dele.
- Chamadas: `POST /api/call?sid=…` com o mesmo `{id, method, params}` do app. Eventos do núcleo:
  `GET /api/events` (SSE). Uma aba aberta = uma sessão.
- Login: nome + senha (hash scrypt em `users.json`, modo 0600), cookie `HttpOnly; SameSite=Strict`,
  sessões em memória (reiniciar o servidor pede login de novo), limite de tentativas por IP.
  Os `POST` exigem o cabeçalho `x-tucano: 1` e `Origin` igual ao host.
- Segredos dos conectores: AES-256-GCM com chave de `TUCANO_SECRET_KEY` ou de `secret.key` (0600)
  na pasta de dados. Não abrem com a chave do chaveiro do app de mesa: use uma pasta de dados nova.
- Uma instância por pasta de dados (`server.lock`).

## Segurança

- Por padrão só escuta em `127.0.0.1`. Para abrir para a rede o servidor exige pelo menos um usuário,
  mas **não faz TLS**: ponha atrás de Tailscale, ou de um proxy com HTTPS e `TUCANO_SECURE=1`.
- Quem entra comanda agentes que rodam comandos nesta máquina e usam as contas de IA dela. Só crie
  usuários de quem você daria um terminal.

## Duas pessoas no mesmo espaço

- Cada mensagem guarda quem a escreveu (`author: { kind: 'me', user }`, no `author_id` que já existia:
  sem migração). Mensagens antigas e as do app de mesa ficam sem `user`.
- Na tela, a sua mensagem é a bolha à direita; a de outra pessoa aparece à esquerda, com avatar e nome.
- O agente vê cada mensagem com o nome de quem escreveu, é avisado de que há mais de uma pessoa e
  responde a quem falou por último (o "você" do prompt passa a ser essa pessoa).
- Memória, agentes, canais e conexões de IA continuam **compartilhados**: é o ponto. A memória "Sobre
  você" é uma só para os dois.

## O que ainda não existe

- Aprovações e rotinas não dizem quem decidiu ou quem criou: valem para o espaço todo, e o texto de
  "aprovou" ainda usa o nome do workspace. O nome do workspace na barra lateral é o do usuário do
  sistema (troque em Configurações).
- Navegador dos agentes: só com Google Chrome instalado (`ChromeBrowsers`). Sem ele, o agente recebe um
  erro claro. Capturar página (`screenshot`) precisa do app de mesa.
- Escolher pasta do disco: no navegador é um campo de texto com o caminho no servidor.
- OAuth de conectores: o callback aponta para o `127.0.0.1` do servidor; só funciona abrindo o navegador
  na própria máquina ou com túnel.
- Login das IAs (`loginEngine`): o servidor devolve o comando; rode-o por SSH na máquina.
- O app de mesa e o servidor **não** podem usar a mesma pasta de dados ao mesmo tempo (rotinas rodariam
  em dobro).
- `npm run dist` ainda empacota só o app de mesa.

Teste de ponta a ponta: `node scripts/screens-web.mjs` (precisa de `npm run build`).
