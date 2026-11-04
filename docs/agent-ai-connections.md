# Conexões de IA por agente

O workspace continua compartilhando canais, histórico e memória. Cada agente escolhe seu modelo e, opcionalmente, uma conexão nomeada, como “Claude João” ou “Claude Cauã”. Sem conexão explícita, permanece a configuração atual da instalação.

As conexões guardam apenas nome, identificador e ferramenta no banco. O login acontece no CLI original, com diretório próprio por conexão. Credenciais não passam pela interface. Uma conexão ausente, desconectada ou de outra ferramenta deve impedir a execução, sem trocar silenciosamente de conta.

O Google passa a ser uma ferramenta disponível pelo Antigravity CLI (`agy`), que substituiu o Gemini CLI. Há streaming, contagem de tokens e acesso aos MCPs pelo gateway existente. Cada execução roda num HOME descartável com só o gateway configurado, e as ferramentas embutidas do `agy` (comandos, arquivos, URLs) são negadas por regra de permissão. Imagens não suportadas geram um erro explícito.

Limite verificado: o login do `agy` não fica em HOME (uma execução com HOME vazio continuou autenticada). Por isso não há conexões nomeadas do Google: vale a conta Google logada no computador onde o Tucano roda. Claude e Codex continuam com uma conta por conexão. Se for preciso mais de uma conta Google, é preciso um usuário do sistema por conta.

Esta entrega altera o aplicativo existente; servidor web, login de visitantes e hospedagem continuam como trabalho separado.

## Implementação e verificação

- [ ] Testar persistência, validação e isolamento de conexões; implementar metadados e diretórios privados.
- [x] Testar o protocolo do `agy` e suas restrições; implementar execução e detecção.
- [ ] Integrar conexão aos agentes, login e teste, mantendo os caminhos atuais como padrão.
- [ ] Acrescentar gerenciamento de conexões e seletor no formulário existente, preservando o estilo do Tucano.
- [ ] Rodar testes, typecheck e build; revisar as mudanças e verificar a interface.

## Decisões

Implementação na branch `feat/agent-ai-connections`, no checkout atual. A autorização para executar as atualizações cobre a implementação proposta na conversa. A seleção de conexão é por agente, sem depender de identidade de visitante. Não serão feitas autenticações reais nem tarefas pagas durante os testes.
