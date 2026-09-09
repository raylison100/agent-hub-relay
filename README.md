# agent-hub-relay

Retransmissor WebSocket sem estado. Daemons abrem conexao de saida e se
registram sob um token de conta. Clientes com o mesmo token veem os
dispositivos online e anexam a um deles. O relay encaminha quadros sem
interpreta-los e recebe webhooks de terceiros para os gatilhos.

Estado: fase 3, funcional. Ver `../docs/05-sincronizacao.md`,
`../docs/10-automacao.md` e `../docs/adr/0004-relay-proprio-com-alternativa-tailscale.md`.

## Rodar

```bash
pnpm install
pnpm build
PORT=8787 node dist/index.js
```

Coloque atras de um proxy com TLS (Caddy, nginx, Cloudflare). O relay nao
termina TLS. Variaveis: `PORT` (8787), `HOST` (0.0.0.0), `RATE_LIMIT`
(requisicoes por minuto por IP, 120).

## Rotas

| Rota | Uso |
|------|-----|
| `GET /health` | estado e quantidade de dispositivos online |
| `WS /device` | daemon, com cabecalhos `x-agent-hub-account`, `x-agent-hub-device-id`, `x-agent-hub-device-name` |
| `WS /client` | cliente; primeiro quadro `relay.auth` com o token de conta |
| `POST /hooks/:device_id/:trigger_id` | webhook de terceiro, encaminhado ao daemon que valida a assinatura |

## Fluxo do cliente

1. `relay.auth { account_token }` e recebe `relay.devices`.
2. `relay.attach { device_id }` e recebe `relay.attached`.
3. A partir dai, os quadros do protocolo do daemon passam direto, comecando
   por `auth` com o token do daemon.

O token de conta agrupa dispositivos e clientes. O token do daemon continua
sendo exigido dentro do canal. O relay guarda apenas o hash do token de
conta em memoria e nada em disco.

## Limites

- Corpo de webhook ate 1 MB.
- Limite de taxa por IP em conexoes e webhooks.
- Dispositivo sem resposta ao ping em 30 s e derrubado; clientes anexados
  recebem `relay.detached`.
- Webhook para dispositivo offline responde 503; sem resposta do daemon em
  5 s responde 504.
