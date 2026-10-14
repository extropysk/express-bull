import type { EventListener, EventsMap, Logger } from '@extropysk/express-core'
import type { RedisOptions } from 'ioredis'

import { BaseEventBus } from '@extropysk/express-core'
import { Redis } from 'ioredis'

type Options = {
  prefix?: string
  logger?: Logger
}

/**
 * Event bus delivering events to all nodes via Redis Pub/Sub.
 * Delivery is at-most-once: nodes that are not subscribed at the time of emit miss the event.
 * The emitting node receives its own events as well.
 */
export class RedisEventBus<Events extends EventsMap = EventsMap> extends BaseEventBus<Events> {
  private publisher: Redis
  // Dedicated connection, because a connection in subscribe mode cannot send other commands
  private subscriber: Redis
  private ownsPublisher: boolean
  private listeners = new Map<string, EventListener>()
  private prefix: string

  constructor(
    connection: Redis | RedisOptions,
    private options: Options = {},
  ) {
    super()
    this.ownsPublisher = !(connection instanceof Redis)
    this.publisher = connection instanceof Redis ? connection : new Redis(connection)
    this.subscriber = this.publisher.duplicate()
    this.prefix = options.prefix ?? 'events'
    // Without error listener ioredis reports every connection error as unhandled
    this.publisher.on('error', error => this.handleError('publisher', error))
    this.subscriber.on('error', error => this.handleError('subscriber', error))
    this.subscriber.on('message', (channel: string, message: string) =>
      this.handleMessage(channel, message),
    )
  }

  async emit<K extends keyof Events & string>(name: K, data: Events[K]): Promise<void> {
    await this.publisher.publish(this.resolveChannel(name), JSON.stringify(data))
  }

  async close() {
    await this.quitClient(this.subscriber)
    if (this.ownsPublisher) {
      await this.quitClient(this.publisher)
    }
  }

  protected listen(name: string, listener: EventListener) {
    const channel = this.resolveChannel(name)
    this.listeners.set(channel, listener)
    this.subscriber.subscribe(channel).catch(error => listener.error(error))

    return () => {
      this.listeners.delete(channel)
      this.subscriber.unsubscribe(channel).catch(error => {
        this.options.logger?.error(
          `Event bus: Failed to unsubscribe from channel ${channel}. ${error}`,
        )
      })
    }
  }

  private handleMessage(channel: string, message: string) {
    const listener = this.listeners.get(channel)
    if (!listener) {
      return
    }

    let data: unknown
    try {
      data = JSON.parse(message)
    } catch (error) {
      this.options.logger?.error(`Event bus: Invalid message on channel ${channel}. ${error}`)
      return
    }
    listener.next(data)
  }

  // `quit()` rejects when the command cannot be sent (e.g. while reconnecting),
  // so close the connection right away instead
  private async quitClient(client: Redis) {
    try {
      await client.quit()
    } catch {
      client.disconnect()
    }
  }

  private handleError(client: string, error: Error) {
    this.options.logger?.error(`Event bus: Redis ${client} error. ${error.message}`)
  }

  private resolveChannel(name: string) {
    return `${this.prefix}:${name}`
  }
}
