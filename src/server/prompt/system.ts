import { paths } from '../config/env'

export const buildSystemInfo = function (): string {
  const systemInfo = [
    '系统信息:',
    `操作系统：${process.platform};`,
    `系统用户：${process.env?.USERNAME || '未知'};`,
    `你的工作空间：${paths.WORKSPACE_ROOT};`,
    `    技能： ${paths.WORKSPACE_ROOT}/skills;`,
    `    脚本： ${paths.WORKSPACE_ROOT}/script;`,
    `    临时目录： ${paths.WORKSPACE_ROOT}/temp;`,
    `    任务目录： ${paths.WORKSPACE_ROOT}/tasks;`,
    `技能目录下有各种各样的扩展能力你可以阅读了解随意取用`,
    `当你需要完成用户给你的任务时必须优先查看技能列表，这里的内容能够真正帮助你更好的完成任务`,
    `当你完成某个任务后，如果你认为流程可以固化时也可以自己建立`,
  ]
  return systemInfo.join('\n')
}
