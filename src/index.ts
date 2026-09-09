#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  isSealed,
  relayHeaders,
  type ClientToRelay,
  type DaemonToRelay,
  type RelayDevice,
  type RelayToClient,
  type RelayToDaemon,
} from '@agent-hub/core'

interface Device {
  id: string
  name: string
  account: string
  socket: WebSocket
  channels: Map<string, ClientConn>
  pendingTriggers: Map<string, (result: { accepted: boolean; reason?: string }) => void>
  alive: boolean
}

interface ClientConn {
  socket: WebSocket
  account: string | null
  device: Device | null
  channel: string | null
  client: string
}

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '0.0.0.0'
const bodyLimit = 1024 * 1024
const rateWindowMs = 60_000
const rateLimit = Number(process.env.RATE_LIMIT ?? 120)
const triggerTimeoutMs = 5000

const devicesByAccount = new Map<string, Map<string, Device>>()
const devicesById = new Map<string, Device>()
const rate = new Map<string, { count: number; reset: number }>()

const server = createServer((req, res) => void route(req, res))
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const path = new URL(req.url ?? '/', 'http://relay').pathname
  if (path !== '/device' && path !== '/client') {
    socket.destroy()
    return
  }
  if (!allow(req)) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => (path === '/device' ? onDevice(ws, req) : onClient(ws)))
})

function onDevice(ws: WebSocket, req: IncomingMessage): void {
  const account = header(req, relayHeaders.accountToken)
  const id = header(req, relayHeaders.deviceId)
  const name = header(req, relayHeaders.deviceName) || 'dispositivo'
  if (!account || !id || account.length < 32) {
    ws.close(4001, 'credenciais ausentes')
    return
  }
  const accountKey = hash(account)
  const previous = devicesById.get(id)
  if (previous && previous.account === accountKey) previous.socket.close(4002, 'substituido')
  const device: Device = { id, name, account: accountKey, socket: ws, channels: new Map(), pendingTriggers: new Map(), alive: true }
  devicesById.set(id, device)
  accountDevices(accountKey).set(id, device)
  ws.on('pong', () => (device.alive = true))
  ws.on('message', (raw) => onDeviceMessage(device, JSON.parse(String(raw)) as DaemonToRelay))
  ws.on('close', () => {
    for (const client of device.channels.values()) {
      client.device = null
      client.channel = null
      sendClient(client, { type: 'relay.detached', reason: 'dispositivo desconectou' })
    }
    device.channels.clear()
    if (devicesById.get(id) === device) devicesById.delete(id)
    accountDevices(accountKey).delete(id)
  })
}

function onDeviceMessage(device: Device, msg: DaemonToRelay): void {
  switch (msg.t) {
    case 'frame': {
      const client = device.channels.get(msg.ch)
      if (client) sendClient(client, msg.frame)
      return
    }
    case 'close': {
      const client = device.channels.get(msg.ch)
      if (client) {
        client.device = null
        client.channel = null
        sendClient(client, { type: 'relay.detached', reason: 'canal fechado pelo dispositivo' })
      }
      device.channels.delete(msg.ch)
      return
    }
    case 'trigger_result':
      device.pendingTriggers.get(msg.id)?.({ accepted: msg.accepted, reason: msg.reason })
      return
    case 'pong':
      device.alive = true
      return
  }
}

function onClient(ws: WebSocket): void {
  const client: ClientConn = { socket: ws, account: null, device: null, channel: null, client: '' }
  ws.on('message', (raw) => onClientMessage(client, JSON.parse(String(raw)) as ClientToRelay))
  ws.on('close', () => detachClient(client))
}

function onClientMessage(client: ClientConn, incoming: ClientToRelay): void {
  if (isSealed(incoming)) {
    if (!client.device || !client.channel) {
      sendClient(client, { type: 'relay.error', message: 'anexe a um dispositivo com relay.attach' })
      return
    }
    sendDevice(client.device, { t: 'frame', ch: client.channel, frame: incoming })
    return
  }
  const msg = incoming
  if (msg.type === 'relay.auth') {
    if (!msg.account_token || msg.account_token.length < 32) {
      sendClient(client, { type: 'relay.error', message: 'token de conta invalido' })
      return
    }
    client.account = hash(msg.account_token)
    client.client = msg.client
    sendClient(client, { type: 'relay.devices', devices: listDevices(client.account) })
    return
  }
  if (!client.account) {
    sendClient(client, { type: 'relay.error', message: 'envie relay.auth primeiro' })
    return
  }
  if (msg.type === 'relay.devices') {
    sendClient(client, { type: 'relay.devices', devices: listDevices(client.account) })
    return
  }
  if (msg.type === 'relay.attach') {
    const device = accountDevices(client.account).get(msg.device_id)
    if (!device) {
      sendClient(client, { type: 'relay.error', message: 'dispositivo offline ou desconhecido' })
      return
    }
    detachClient(client)
    const channel = randomUUID()
    client.device = device
    client.channel = channel
    device.channels.set(channel, client)
    sendDevice(device, { t: 'open', ch: channel, client: client.client })
    sendClient(client, { type: 'relay.attached', device_id: device.id, device_name: device.name })
    return
  }
  if (!client.device || !client.channel) {
    sendClient(client, { type: 'relay.error', message: 'anexe a um dispositivo com relay.attach' })
    return
  }
  sendDevice(client.device, { t: 'frame', ch: client.channel, frame: msg })
}

function detachClient(client: ClientConn): void {
  if (client.device && client.channel) {
    sendDevice(client.device, { t: 'close', ch: client.channel })
    client.device.channels.delete(client.channel)
  }
  client.device = null
  client.channel = null
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://relay')
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { ok: true, devices: devicesById.size })
    return
  }
  const hook = /^\/hooks\/([^/]+)\/([^/]+)$/.exec(url.pathname)
  if (req.method === 'POST' && hook) {
    if (!allow(req)) {
      json(res, 429, { error: 'limite de taxa' })
      return
    }
    await handleHook(req, res, hook[1]!, hook[2]!)
    return
  }
  json(res, 404, { error: 'nao encontrado' })
}

async function handleHook(req: IncomingMessage, res: ServerResponse, deviceId: string, triggerId: string): Promise<void> {
  const device = devicesById.get(deviceId)
  if (!device) {
    json(res, 503, { error: 'dispositivo offline' })
    return
  }
  let body: string
  try {
    body = await readBody(req)
  } catch {
    json(res, 413, { error: 'corpo grande demais' })
    return
  }
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v
  const id = randomUUID()
  const result = await new Promise<{ accepted: boolean; reason?: string }>((resolve) => {
    const timer = setTimeout(() => {
      device.pendingTriggers.delete(id)
      resolve({ accepted: false, reason: 'dispositivo nao respondeu' })
    }, triggerTimeoutMs)
    device.pendingTriggers.set(id, (r) => {
      clearTimeout(timer)
      device.pendingTriggers.delete(id)
      resolve(r)
    })
    sendDevice(device, { t: 'trigger', id, trigger_id: triggerId, headers, body })
  })
  if (result.accepted) json(res, 202, { accepted: true })
  else json(res, result.reason === 'dispositivo nao respondeu' ? 504 : 400, { accepted: false, reason: result.reason })
}

function listDevices(account: string): RelayDevice[] {
  return [...accountDevices(account).values()].map((d) => ({ id: d.id, name: d.name, online: true }))
}

function accountDevices(account: string): Map<string, Device> {
  let map = devicesByAccount.get(account)
  if (!map) {
    map = new Map()
    devicesByAccount.set(account, map)
  }
  return map
}

function sendClient(client: ClientConn, frame: RelayToClient): void {
  if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(frame))
}

function sendDevice(device: Device, msg: RelayToDaemon): void {
  if (device.socket.readyState === device.socket.OPEN) device.socket.send(JSON.stringify(msg))
}

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name]
  return typeof v === 'string' ? v : ''
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function allow(req: IncomingMessage): boolean {
  const ip = (header(req, 'x-forwarded-for').split(',')[0] || req.socket.remoteAddress || 'desconhecido').trim()
  const now = Date.now()
  const entry = rate.get(ip)
  if (!entry || entry.reset < now) {
    rate.set(ip, { count: 1, reset: now + rateWindowMs })
    return true
  }
  entry.count += 1
  return entry.count <= rateLimit
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > bodyLimit) {
        reject(new Error('limite'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

setInterval(() => {
  for (const device of devicesById.values()) {
    if (!device.alive) {
      device.socket.terminate()
      continue
    }
    device.alive = false
    sendDevice(device, { t: 'ping' })
    device.socket.ping()
  }
  for (const [ip, entry] of rate) if (entry.reset < Date.now()) rate.delete(ip)
}, 30_000)

server.listen(port, host, () => console.log(`relay em http://${host}:${port} (ws em /device e /client, webhooks em /hooks/:device/:trigger)`))
