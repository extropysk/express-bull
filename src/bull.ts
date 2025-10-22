import type { BaseWorker } from '@extropysk/express-core'
import type { ConnectionOptions } from 'bullmq'

import { BaseQueue, QueueProvider } from '@extropysk/express-core'
import { Queue, Worker } from 'bullmq'
import type { Job } from 'bullmq'
import { type BaseCron, BaseCronProvider } from '@extropysk/express-core'

interface Data {
  name: string
}

class BullQueue<DataType extends Data> extends BaseQueue<DataType> {
  private queue: Queue
  constructor(name: string, connection: ConnectionOptions) {
    super()
    this.queue = new Queue(name, { connection })
  }

  async add(data: DataType) {
    await this.queue.add(data.name, data)
  }
}

export class BullProvider extends QueueProvider {
  constructor(private connection: ConnectionOptions) {
    super()
  }

  createQueue<DataType extends Data>(name: string) {
    return new BullQueue<DataType>(name, this.connection)
  }

  registerWorker<DataType extends Data>(worker: BaseWorker<DataType>) {
    const bullWorker = new Worker(worker.resolveName(), job => worker.process(job.data), {
      connection: this.connection,
    })
    bullWorker.on('completed', job => worker.onCompleted(job))
    bullWorker.on('failed', (job, error) => worker.onFailed(job, error))
  }
}

export class BullCronProvider extends BaseCronProvider {
  private queue: Queue

  constructor(private connection: ConnectionOptions) {
    super()

    this.queue = new Queue('cron', { connection })
  }

  register(cron: BaseCron) {
    const name = cron.resolveName()

    this.queue
      .upsertJobScheduler(
        name,
        {
          pattern: cron.resolveExpression(),
        },
        {
          name,
          data: cron.resolveData(),
          opts: {
            removeOnComplete: true,
            removeOnFail: true,
          },
        },
      )
      .catch(console.error)

    new Worker('cron', (job: Job) => cron.process(job), { connection: this.connection })
  }
}
