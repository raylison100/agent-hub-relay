# agent-hub-relay

Retransmissor WebSocket sem estado. Daemons registram-se com conexao de
saida, clientes remotos conectam e o relay encaminha quadros entre os dois
sem interpreta-los.

Estado: fase 0, sem codigo. Entra na fase 3. Planejamento em
`../docs/05-sincronizacao.md` e `../docs/adr/0004-relay-proprio-com-alternativa-tailscale.md`.

Estrutura prevista:

```
src/
  index.ts      servidor ws e http de saude
  registry.ts   mapa de dispositivos online por conta
  forward.ts    encaminhamento e limites
```
