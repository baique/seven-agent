import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { ToolResult } from '../../utils/tool-response'
import { terminalManagerSingleton } from '../../terminal'

const terminalManager = terminalManagerSingleton
const terminalSchema = z.object({
  action: z.enum(['exec', 'write', 'interrupt', 'printScreen', 'printDiffScreen']).describe(`
    指令
      exec 输入命令、文本、或方向键
      interrupt 中断会话
      printScreen 获取当前会话屏幕日志
      printDiffScreen 获取会话屏幕日志中哪些内容变化了(推荐使用)
    `),
  sessionId: z.string().describe('会话ID，如果需要保持终端状态时，请主动设置会话ID'),
  command: z.string().optional().describe('输入终端的命令'),
  cwd: z.string().optional().describe('工作目录，默认使用工作空间'),
  waitLog: z.boolean().optional().describe('是否等待日志稳定后返回，默认等待'),
})

export const terminalTool = new DynamicStructuredTool({
  name: 'terminal',
  description: `终端命令执行工具支持执行各种命令与TUI交互
# 使用说明

## 输入命令或交互
使用exec指令，将需要执行的命令作为command参数输入。
exec指令会在执行趋近稳定后返回相关信息，如sessionId、当前屏幕日志、具体文本日志等。
需要注意的是，数据返回**不代表命令成功或者执行完毕，具体执行结果你需要自行阅读日志**。

如果不希望等待指令返回，或者需要并行执行其他动作时：
将waitLog参数设为false，命令将在10s内返回（返回结果中仍会收集日志，这是为了在失败时可以做出及时的调整）

sessionId最佳实践:
- 推荐总是设置sessionId参数，以保持终端状态
- 优先考虑使用已存在的终端，只有已存在终端有未完成任务时，才创建新的终端

## 读取日志
推荐使用printDiffScreen指令，获取会话屏幕日志中哪些内容变化，变化是相对于上一次调用printScreen或者printDiffScreen指令时的屏幕状态
使用printScreen指令，可以获取当前屏幕中的日志
只有当以上两者给出的信息都不足时，才使用文件相关工具读取日志文件

## 中断
对于持续运行的命令，如启动服务、监听端口等，使用interrupt指令可以中断

# 示例
### 执行命令
{ sessionId: 'session-1', action: 'exec', command: "ls -la" }
{ sessionId: 'session-1',action: 'exec', command: "git commit -m 'fix: 修复问题'" }
{ sessionId: 'session-1',action: 'exec', command: "cat << EOF\\n第一行\\n第二行\\nEOF" }

### 输入方向键（ANSI 转义序列）
{ sessionId: 'session-1',action: 'write', command: "\\x1B[A" }  // 上箭头
{ sessionId: 'session-1',action: 'write', command: "\\x1B[B" }  // 下箭头
{ sessionId: 'session-1',action: 'write', command: "\\x1B[C" }  // 右箭头
{ sessionId: 'session-1',action: 'write', command: "\\x1B[D" }  // 左箭头
…………

### 中断命令
{ sessionId: 'session-1',action: 'interrupt' }
`,
  schema: terminalSchema,
  func: async ({ action, sessionId, command, cwd, waitLog }) => {
    const toolName = 'terminal'

    try {
      switch (action) {
        case 'interrupt':
          await terminalManager.interrupt(sessionId || '')
          return await ToolResult.success(toolName, {
            msg: '终止指令已发出，如需获取终端状态请重新获取日志',
          })
        case 'exec': {
          const result = await terminalManager.exec(
            sessionId || '',
            command || '',
            cwd || '',
            waitLog,
          )
          return await ToolResult.success(toolName, {
            msg: '指令已输入',
            body: result.currentContent,
            extra: {
              sessionId: result.sessionId,
              outputToFile: result.outputToFile,
            },
          })
        }

        case 'printDiffScreen': {
          if (!sessionId) {
            return await ToolResult.error(toolName, {
              msg: `操作失败：${action} 需要会话ID`,
              extra: { sessionId },
            })
          }
          const currentScreenSnapshot = await terminalManager
            .getSession(sessionId)
            ?.getDiffLogScreen()
          return await ToolResult.success(toolName, {
            msg: '会话变化内容',
            body: currentScreenSnapshot,
          })
        }
        case 'printScreen': {
          if (!sessionId) {
            return await ToolResult.error(toolName, {
              msg: `操作失败：${action} 需要会话ID`,
              extra: { sessionId },
            })
          }
          const currentScreenSnapshot = await terminalManager.getSession(sessionId)?.getLogScreen()
          return await ToolResult.success(toolName, {
            msg: '当前会话屏幕',
            body: currentScreenSnapshot,
          })
        }
        default:
          return await ToolResult.error(toolName, {
            msg: `操作失败：${action} 不支持`,
            extra: { sessionId },
          })
      }
    } catch (error) {
      return await ToolResult.error(toolName, {
        msg: `执行失败：${error}`,
        extra: { sessionId },
      })
    }
  },
})
