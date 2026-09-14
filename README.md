# agent-hub-relay

Retransmissor WebSocket sem estado para usar o Agent Hub fora de casa sem abrir
porta no roteador. O [daemon](https://github.com/raylison100/agent-hub-daemon)
abre uma conexao de saida para o relay; clientes remotos (navegador, celular,
Telegram) conectam no relay e anexam ao seu dispositivo. O relay so encaminha
quadros: o conteudo vai cifrado ponta a ponta entre o cliente e o daemon, e ele
nao le, nao guarda e nao decide nada.

Tambem recebe webhooks de terceiros e entrega ao daemon, que confere a
assinatura antes de disparar um gatilho.

## Rodar

```bash
pnpm install
pnpm build
PORT=8787 node dist/index.js
```

Coloque atras de um proxy com TLS (Caddy, nginx, Cloudflare); o relay nao
termina TLS. Variaveis: `PORT` (8787), `HOST` (0.0.0.0), `RATE_LIMIT`
(requisicoes por minuto por IP, 120).

No daemon, configure `relay_url` no `config.toml`; `agent-hub-daemon pair`
mostra o token de conta e o id do dispositivo.

## Rotas

| Rota | Uso |
|---|---|
| `GET /health` | estado e quantidade de dispositivos online |
| `WS /device` | daemon, com cabecalhos `x-agent-hub-account`, `x-agent-hub-device-id`, `x-agent-hub-device-name` |
| `WS /client` | cliente; primeiro quadro `relay.auth` com o token de conta |
| `POST /hooks/:device_id/:trigger_id` | webhook de terceiro, encaminhado ao daemon |

## Fluxo do cliente

1. `relay.auth { account_token }` e recebe `relay.devices`.
2. `relay.attach { device_id }` e recebe `relay.attached`.
3. Dali em diante passam os quadros do protocolo do daemon, cifrados, comecando
   pela autenticacao no daemon.

O relay guarda so o hash do token de conta, em memoria, e nada em disco.

## Limites

- Corpo de webhook ate 1 MB.
- Limite de taxa por IP em conexoes e webhooks.
- Dispositivo sem resposta ao ping em 30 s e derrubado; clientes anexados
  recebem `relay.detached`.
- Webhook para dispositivo offline responde 503; sem resposta do daemon em 5 s,
  504.

## Parte do Agent Hub

Este repositorio e uma das partes do [Agent Hub](https://github.com/raylison100/agent-hub),
um gerenciador de modelos de IA que roda na sua maquina. A documentacao geral
esta na [wiki](https://github.com/raylison100/agent-hub/wiki).

| Repositorio | Papel |
|---|---|
| [agent-hub](https://github.com/raylison100/agent-hub) | ponto de partida, Makefile, scripts e wiki |
| [agent-hub-core](https://github.com/raylison100/agent-hub-core) | biblioteca TypeScript: adaptadores, laco do agente, custo, roteamento, ferramentas, protocolo |
| [agent-hub-daemon](https://github.com/raylison100/agent-hub-daemon) | servico local: sessoes, runs, aprovacoes, automacao, conectores, API WebSocket |
| [agent-hub-web](https://github.com/raylison100/agent-hub-web) | interface Vue 3 como PWA, a mesma no navegador, no celular e no desktop |
| [agent-hub-agents](https://github.com/raylison100/agent-hub-agents) | perfis, papeis, skills, workflows, precos, roteamento e politicas, em texto |
| [agent-hub-desktop](https://github.com/raylison100/agent-hub-desktop) | app Tauri 2 para Windows e Linux |
| [agent-hub-relay](https://github.com/raylison100/agent-hub-relay) | retransmissor sem estado para acesso remoto |
| [agent-hub-channels](https://github.com/raylison100/agent-hub-channels) | clientes em plataformas de mensagem, hoje Telegram |
| [agent-hub-docs](https://github.com/raylison100/agent-hub-docs) | planejamento, arquitetura, ADRs e a fonte das paginas da wiki |

## Licenca

[PolyForm Noncommercial 1.0.0](LICENSE). Pode ler, estudar, modificar e usar
para fins pessoais, de pesquisa, ensino ou em organizacao sem fins lucrativos.
Uso comercial nao e permitido sem autorizacao do autor.

Required Notice: Copyright (c) 2026 Raylison Nunes (https://github.com/raylison100)
