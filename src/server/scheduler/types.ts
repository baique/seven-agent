import { CronJob as CronJobInstance } from 'cron'

export interface SchedulerJobConfig {
  name: string
  cronExpression: string
  handler: () => void | Promise<void>
  enabled?: boolean
}

export interface SchedulerJobInfo {
  id: string
  name: string
  cronExpression: string
  enabled: boolean
  lastRun?: Date
  nextRun?: Date
  createdAt: number
}

export interface InternalJob {
  id: string
  name: string
  cronExpression: string
  handler: () => void | Promise<void>
  enabled: boolean
  createdAt: number
  cronJob: CronJobInstance<null, null>
}
