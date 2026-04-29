import { randomUUID } from 'crypto'
import { CronJob } from 'cron'
import { SchedulerJobConfig, SchedulerJobInfo, InternalJob } from './types'
import { logger } from '../utils'

export class Scheduler {
  private jobs: Map<string, InternalJob> = new Map()

  addJob(config: SchedulerJobConfig): string {
    const id = randomUUID()
    const enabled = config.enabled ?? true

    const cronJob = new CronJob(
      config.cronExpression,
      async () => {
        const job = this.jobs.get(id)
        if (!job || !job.enabled) return

        logger.debug(`[Scheduler] Executing job: ${job.name} (${id})`)
        try {
          await job.handler()
          logger.debug(`[Scheduler] Job completed: ${job.name}`)
        } catch (error) {
          logger.error({ err: error }, `[Scheduler] Job failed: ${job.name}`)
        }
      },
      null,
      enabled,
    )

    const job: InternalJob = {
      id,
      name: config.name,
      cronExpression: config.cronExpression,
      handler: config.handler,
      enabled,
      createdAt: Date.now(),
      cronJob,
    }

    this.jobs.set(id, job)

    const nextRun = cronJob.nextDate()?.toJSDate()
    logger.info(
      `[Scheduler] Job added: ${job.name} (${id}), next run: ${nextRun?.toISOString() ?? 'N/A'}`,
    )

    return id
  }

  removeJob(id: string): boolean {
    const job = this.jobs.get(id)
    if (job) {
      job.cronJob.stop()
      this.jobs.delete(id)
      logger.info(`[Scheduler] Job removed: ${job.name} (${id})`)
      return true
    }
    return false
  }

  getJob(id: string): SchedulerJobInfo | undefined {
    const job = this.jobs.get(id)
    if (!job) return undefined
    return this.toJobInfo(job)
  }

  getAllJobs(): SchedulerJobInfo[] {
    return Array.from(this.jobs.values()).map(this.toJobInfo)
  }

  enableJob(id: string): boolean {
    const job = this.jobs.get(id)
    if (job) {
      job.enabled = true
      job.cronJob.start()
      logger.info(`[Scheduler] Job enabled: ${job.name} (${id})`)
      return true
    }
    return false
  }

  disableJob(id: string): boolean {
    const job = this.jobs.get(id)
    if (job) {
      job.enabled = false
      job.cronJob.stop()
      logger.info(`[Scheduler] Job disabled: ${job.name} (${id})`)
      return true
    }
    return false
  }

  updateJobHandler(id: string, handler: () => void | Promise<void>): boolean {
    const job = this.jobs.get(id)
    if (job) {
      job.handler = handler
      logger.info(`[Scheduler] Job handler updated: ${job.name} (${id})`)
      return true
    }
    return false
  }

  updateJobCron(id: string, cronExpression: string): boolean {
    const job = this.jobs.get(id)
    if (!job) return false

    job.cronJob.stop()

    const newCronJob = new CronJob(
      cronExpression,
      async () => {
        if (!job.enabled) return
        logger.debug(`[Scheduler] Executing job: ${job.name} (${id})`)
        try {
          await job.handler()
          logger.debug(`[Scheduler] Job completed: ${job.name}`)
        } catch (error) {
          logger.error({ err: error }, `[Scheduler] Job failed: ${job.name}`)
        }
      },
      null,
      job.enabled,
    )

    job.cronJob = newCronJob
    job.cronExpression = cronExpression

    if (job.enabled) {
      newCronJob.start()
    }

    const nextRun = newCronJob.nextDate()?.toJSDate()
    logger.info(
      `[Scheduler] Job cron updated: ${job.name} (${id}), next run: ${nextRun?.toISOString() ?? 'N/A'}`,
    )
    return true
  }

  stopAll(): void {
    for (const job of this.jobs.values()) {
      job.cronJob.stop()
    }
    logger.info('[Scheduler] All jobs stopped')
  }

  startAll(): void {
    for (const job of this.jobs.values()) {
      if (job.enabled) {
        job.cronJob.start()
      }
    }
    logger.info('[Scheduler] All enabled jobs started')
  }

  private toJobInfo(job: InternalJob): SchedulerJobInfo {
    return {
      id: job.id,
      name: job.name,
      cronExpression: job.cronExpression,
      enabled: job.enabled,
      lastRun: job.cronJob.lastDate() ?? undefined,
      nextRun: job.cronJob.nextDate()?.toJSDate(),
      createdAt: job.createdAt,
    }
  }
}

export const scheduler = new Scheduler()
