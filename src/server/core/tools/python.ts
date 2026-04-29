import { DynamicStructuredTool } from '@langchain/core/tools'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { logger } from '../../utils/logger'
import { ToolResult } from '../../utils/tool-response'

const pythonREPLSchema = z.object({
  code: z.string().describe('要执行的Python代码'),
  timeout: z.number().optional().describe('超时时间（毫秒），默认30000ms'),
})

const pythonCommand = process.platform === 'win32' ? 'python' : 'python3'

function checkPythonEnvironment(): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn(pythonCommand, ['--version'], { windowsHide: true })
    check.on('error', () => resolve(false))
    check.on('close', (code) => resolve(code === 0))
  })
}

export const pythonREPLTool = new DynamicStructuredTool({
  name: 'python_repl',
  description:
    '执行Python代码并返回结果。用于数据处理、计算、脚本执行等。代码在临时文件中执行，执行完毕后自动删除。',
  schema: pythonREPLSchema,
  func: async ({ code, timeout = 30000 }) => {
    const toolName = 'python_repl'
    logger.info(`[python_repl] 执行Python代码`)

    const isPythonAvailable = await checkPythonEnvironment()
    if (!isPythonAvailable) {
      return await ToolResult.error(toolName, {
        msg: 'Python 环境未安装或未配置',
        body: `未找到 ${pythonCommand}，请确保系统已安装 Python 并添加到环境变量`,
        extra: { errorType: 'python_not_found' },
      })
    }

    const tempFile = join(tmpdir(), `python_${randomUUID()}.py`)

    try {
      await writeFile(tempFile, code, 'utf-8')

      return new Promise((resolve) => {
        const child = spawn(pythonCommand, [tempFile], {
          timeout,
          windowsHide: true,
        })

        let stdout = ''
        let stderr = ''

        child.stdout?.on('data', (data) => {
          stdout += data.toString()
        })

        child.stderr?.on('data', (data) => {
          stderr += data.toString()
        })

        child.on('error', async (error) => {
          logger.error(`[python_repl] 执行错误: ${error.message}`)
          try {
            await unlink(tempFile)
          } catch {}
          resolve(
            await ToolResult.error(toolName, {
              msg: 'Python执行错误，请确保系统已安装Python并配置好环境变量',
              body: error.message,
              extra: { errorType: 'spawn_error' },
            }),
          )
        })

        child.on('close', async (code) => {
          try {
            await unlink(tempFile)
          } catch {}

          if (code === 0) {
            logger.info(`[python_repl] 执行成功`)
            if (stdout) {
              resolve(
                await ToolResult.success(toolName, {
                  msg: 'Python执行成功',
                  body: stdout,
                  extra: { exitCode: code },
                }),
              )
            } else {
              resolve(
                await ToolResult.success(toolName, {
                  msg: 'Python代码执行成功，无输出',
                  extra: { exitCode: code },
                }),
              )
            }
          } else {
            logger.warn(`[python_repl] 执行失败，退出码: ${code}`)
            const shortDesc = stderr ? 'Python执行出错' : `Python执行失败 (退出码: ${code})`
            resolve(
              await ToolResult.error(toolName, {
                msg: shortDesc,
                body: stderr,
                extra: { exitCode: code },
              }),
            )
          }
        })
      })
    } catch (error) {
      try {
        await unlink(tempFile)
      } catch {}
      const errorMsg = error instanceof Error ? error.message : String(error)
      logger.error(`[python_repl] 执行失败: ${errorMsg}`)
      return await ToolResult.error(toolName, {
        msg: 'Python执行失败',
        body: errorMsg,
      })
    }
  },
})
