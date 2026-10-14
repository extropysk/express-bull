import type { Logger } from '@extropysk/express-core'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RedisEventBus } from './events'

type Listener = (channel: string, message: string) => void

// Simulates Redis server shared by all connections
const broker = vi.hoisted(() => {
  const connections = new Set<{ channels: Set<string>; listeners: Listener[] }>()
  return {
    connections,
    publish(channel: string, message: string) {
      connections.forEach(client => {
        if (client.channels.has(channel)) {
          client.listeners.forEach(listener => listener(channel, message))
        }
      })
    },
  }
})

vi.mock('ioredis', () => {
  class Redis {
    channels = new Set<string>()
    listeners: Listener[] = []

    constructor() {
      broker.connections.add(this)
    }

    duplicate() {
      return new Redis()
    }

    publish = vi.fn(async (channel: string, message: string) => broker.publish(channel, message))
    subscribe = vi.fn(async (channel: string) => this.channels.add(channel))
    unsubscribe = vi.fn(async (channel: string) => this.channels.delete(channel))
    quit = vi.fn(async () => broker.connections.delete(this))
    disconnect = vi.fn(() => broker.connections.delete(this))
    errorListeners: ((error: Error) => void)[] = []

    on(event: 'message' | 'error', listener: any) {
      if (event === 'error') {
        this.errorListeners.push(listener)
      } else {
        this.listeners.push(listener)
      }
    }
  }
  return { Redis }
})

const logger = {
  debug: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  trace: vi.fn(),
  silent: vi.fn(),
  level: 'debug',
} as Logger

interface TestEvents {
  created: { id: string }
  deleted: { id: string }
}

const createBus = () => new RedisEventBus<TestEvents>({}, { logger })

const subscriberOf = (bus: RedisEventBus<any>) => bus['subscriber'] as any

const flush = () => new Promise(res => setTimeout(res, 0))

describe('RedisEventBus', () => {
  beforeEach(() => {
    broker.connections.clear()
  })

  it('should deliver event to all nodes', async () => {
    const node1 = createBus()
    const node2 = createBus()
    const handler1 = vi.fn()
    const handler2 = vi.fn()

    node1.on('created').subscribe(handler1)
    node2.on('created').subscribe(handler2)
    await flush()

    await node1.emit('created', { id: '1' })

    expect(handler1).toHaveBeenCalledWith({ id: '1' })
    expect(handler2).toHaveBeenCalledWith({ id: '1' })
  })

  it('should deliver event only to subscribers of given name', async () => {
    const bus = createBus()
    const handler = vi.fn()

    bus.on('deleted').subscribe(handler)
    await flush()

    await bus.emit('created', { id: '1' })

    expect(handler).not.toHaveBeenCalled()
  })

  it('should subscribe channel once and unsubscribe after last observer', async () => {
    const bus = createBus()
    const subscriber = subscriberOf(bus)

    const first = bus.on('created').subscribe()
    const second = bus.on('created').subscribe()
    await flush()

    expect(subscriber.subscribe).toHaveBeenCalledTimes(1)
    expect(subscriber.subscribe).toHaveBeenCalledWith('events:created')

    first.unsubscribe()
    expect(subscriber.unsubscribe).not.toHaveBeenCalled()

    second.unsubscribe()
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('events:created')

    bus.on('created').subscribe()
    await flush()
    expect(subscriber.subscribe).toHaveBeenCalledTimes(2)
  })

  it('should skip invalid messages', async () => {
    const bus = createBus()
    const handler = vi.fn()

    bus.on('created').subscribe(handler)
    await flush()

    broker.publish('events:created', 'not-json')
    await bus.emit('created', { id: '1' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ id: '1' })
    expect(logger.error).toHaveBeenCalled()
  })

  it('should log connection errors', () => {
    const bus = createBus()

    subscriberOf(bus).errorListeners.forEach((listener: any) => listener(new Error('ECONNREFUSED')))

    expect(logger.error).toHaveBeenCalledWith('Event bus: Redis subscriber error. ECONNREFUSED')
  })

  it('should disconnect when quit fails on close', async () => {
    const bus = createBus()
    const subscriber = subscriberOf(bus)
    const publisher = bus['publisher'] as any
    subscriber.quit.mockRejectedValueOnce(new Error('Connection is closed'))

    await bus.close()

    expect(subscriber.disconnect).toHaveBeenCalled()
    expect(publisher.quit).toHaveBeenCalled()
  })
})
