import 'dotenv/config'
import { createHybridServer, isPortInUse } from './socket'
import { logger } from './utils/logger'
import { env, configManager } from './config/env'
import { settingManager } from './config/setting-manager'
import { initWorkspace } from './utils/workspace'
import { startLongTermSummaryScheduler } from './scheduler/long-term-summary'
import { scheduler, startCleanupScheduler } from './scheduler'
import { startReminderChecker } from './scheduler/reminder-checker'
import { jsonMemoryManager } from './memory'
import { terminalManagerSingleton } from './terminal'
import { taskManager } from './core/tools/task/task-manager'
import { BUFFER_WINDOW_CONTEXT } from './core/state/context/impl/buffer-window'
import { STATE_CONTEXT } from './core/state/context/impl/character-state'
import { registerSocketHandlers } from './handlers'
import { registerSystemHooks } from './core/hook'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

const socketPort = env.SOCKET_PORT
const hybridServer = createHybridServer({
  port: socketPort,
})

/**
 * 检查是否启用了强制模式
 * 通过环境变量 SERVER_FORCE_MODE 或命令行参数 --force 判断
 */
function isForceMode(): boolean {
  return process.env.SERVER_FORCE_MODE === 'true' || process.argv.includes('--force')
}

/**
 * 获取占用指定端口的进程 PID
 * @param port 端口号
 * @returns PID 或 null
 */
async function getProcessOnPort(port: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      // Windows: 使用 netstat 查找占用端口的进程
      const { stdout } = await execAsync(`netstat -ano | findstr :${port}`)
      const lines = stdout.split('\n').filter((line) => line.trim())
      for (const line of lines) {
        const parts = line.trim().split(/\s+/)
        if (parts.length >= 5) {
          const localAddress = parts[1]
          if (localAddress.includes(`:${port}`)) {
            const pid = parseInt(parts[4], 10)
            if (!isNaN(pid) && pid !== process.pid) {
              return pid
            }
          }
        }
      }
    } else {
      // Unix/Linux/Mac: 使用 lsof 查找占用端口的进程
      const { stdout } = await execAsync(`lsof -t -i:${port}`)
      const pids = stdout.split('\n').filter((pid) => pid.trim())
      for (const pidStr of pids) {
        const pid = parseInt(pidStr, 10)
        if (!isNaN(pid) && pid !== process.pid) {
          return pid
        }
      }
    }
  } catch {
    // 命令执行失败，可能没有进程占用端口
  }
  return null
}

/**
 * 强制结束指定 PID 的进程
 * @param pid 进程 ID
 */
async function killProcess(pid: number): Promise<void> {
  try {
    if (process.platform === 'win32') {
      // Windows: 使用 taskkill 强制结束进程
      await execAsync(`taskkill /F /PID ${pid} /T`)
    } else {
      // Unix/Linux/Mac: 使用 kill -9 强制结束进程
      process.kill(pid, 'SIGKILL')
    }
    logger.info(`[Server] 已强制结束进程 PID: ${pid}`)
  } catch (error) {
    logger.error({ error }, `[Server] 结束进程 PID: ${pid} 失败`)
    throw error
  }
}

/**
 * 强制释放端口
 * 查找并结束占用指定端口的进程
 * @param port 端口号
 */
async function forceReleasePort(port: number): Promise<void> {
  logger.info(`[Server] 正在强制释放端口 ${port}...`)

  // 等待一小段时间让端口释放
  await new Promise((resolve) => setTimeout(resolve, 500))

  // 再次检查端口是否仍被占用
  const stillInUse = await isPortInUse(port)
  if (!stillInUse) {
    logger.info(`[Server] 端口 ${port} 已释放`)
    return
  }

  // 如果端口仍被占用，尝试查找并结束进程
  const pid = await getProcessOnPort(port)
  if (pid) {
    logger.info(`[Server] 发现占用端口 ${port} 的进程 PID: ${pid}`)
    await killProcess(pid)

    // 等待进程结束
    let attempts = 0
    const maxAttempts = 10
    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const inUse = await isPortInUse(port)
      if (!inUse) {
        logger.info(`[Server] 端口 ${port} 已成功释放`)
        return
      }
      attempts++
    }
    throw new Error(`无法释放端口 ${port}，进程可能未响应`)
  } else {
    logger.warn(`[Server] 无法找到占用端口 ${port} 的进程`)
    throw new Error(`无法找到占用端口 ${port} 的进程`)
  }
}

let isCleaningUp = false
let isStarted = false

/**
 * 统一的资源清理函数
 * 确保所有资源都能被正确释放
 */
async function cleanup(): Promise<void> {
  if (isCleaningUp) {
    logger.info('[Cleanup] 清理已在进行中，跳过重复清理')
    return
  }
  isCleaningUp = true
  logger.info('[Cleanup] 开始清理资源...')

  try {
    scheduler.stopAll()
    logger.info('[Cleanup] 定时任务已停止')
  } catch (error) {
    logger.error({ error }, '[Cleanup] 停止定时任务失败')
  }

  try {
    await BUFFER_WINDOW_CONTEXT.persist()
    logger.info('[Cleanup] 缓冲窗口上下文已持久化')
  } catch (error) {
    logger.error({ error }, '[Cleanup] 持久化缓冲窗口上下文失败')
  }

  try {
    terminalManager.destroyAll()
    logger.info('[Cleanup] 终端会话已销毁')
  } catch (error) {
    logger.error({ error }, '[Cleanup] 销毁终端会话失败')
  }

  try {
    configManager.stopWatching()
    logger.info('[Cleanup] 配置文件监听已停止')
  } catch (error) {
    logger.error({ error }, '[Cleanup] 停止配置文件监听失败')
  }

  try {
    settingManager.stopWatching()
    logger.info('[Cleanup] 配置中心监听已停止')
  } catch (error) {
    logger.error({ error }, '[Cleanup] 停止配置中心监听失败')
  }

  try {
    await hybridServer.stop()
    logger.info('[Cleanup] Socket服务器已停止')
  } catch (error) {
    logger.error({ error }, '[Cleanup] 停止Socket服务器失败')
  }

  // JSON存储不需要显式关闭连接
  logger.info('[Cleanup] JSON存储无需关闭连接')

  logger.info('[Cleanup] 资源清理完成')
}

// 终端管理器单例
const terminalManager = terminalManagerSingleton
terminalManager.setBroadcastCallback((event: string, data: unknown) => {
  hybridServer.broadcast({
    code: 200,
    message: '',
    type: event,
    data,
    timestamp: Date.now(),
  })
})

// 任务管理器广播
taskManager.setBroadcastCallback((event: string, data: unknown) => {
  hybridServer.broadcast({
    code: 200,
    message: '',
    type: event,
    data,
    timestamp: Date.now(),
  })
})

// 人格状态管理器广播
STATE_CONTEXT.setBroadcastCallback((event: string, data: unknown) => {
  hybridServer.broadcast({
    code: 200,
    message: '',
    type: event,
    data,
    timestamp: Date.now(),
  })
})

/**
 * 启动Server
 * 可以被主进程调用，也可以独立运行
 */
export async function startServer(): Promise<void> {
  if (isStarted) {
    logger.info('[Server] Server已经启动，跳过重复启动')
    return
  }

  logger.info('[Server] 正在启动...')

  try {
    await initWorkspace()
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      '[Server] 工作空间初始化失败',
    )
    throw error
  }

  // 注册系统级Hook
  registerSystemHooks()

  // 注册所有Socket命令处理器
  registerSocketHandlers(hybridServer.getHandler())

  hybridServer.on('onConnection', (socket) => {
    logger.info('[Server] Client connected')
    socket.send(
      JSON.stringify({
        code: 200,
        type: 'socket:ready',
        data: {},
        timestamp: Date.now(),
      }) + '\n',
    )
  })

  hybridServer.on('onDisconnect', () => {
    logger.info('[Server] Client disconnected')
  })

  const portInUse = await isPortInUse(socketPort)
  if (portInUse) {
    if (isForceMode()) {
      logger.info(`[Server] 端口 ${socketPort} 已被占用，--force 模式启用，尝试强制释放端口`)
      try {
        await forceReleasePort(socketPort)
      } catch (error) {
        logger.error({ error }, `[Server] 强制释放端口 ${socketPort} 失败`)
        throw error
      }
    } else {
      logger.info(`[Server] 端口 ${socketPort} 已被占用，服务可能已启动`)
      return
    }
  }

  await hybridServer.start()
  logger.info(`[Server] 服务已启动，端口: ${socketPort}`)

  // 启动调度器
  startLongTermSummaryScheduler()
  startReminderChecker()
  startCleanupScheduler()

  // 启动配置热重载监听
  configManager.startWatching()

  // 启动配置中心热重载监听
  settingManager.startWatching()

  // 初始化 MCP 配置管理（启动配置监听和工具缓存检查）
  const { initializeMCPConfig } = await import('./core/tools/tools-collection')
  await initializeMCPConfig()

  isStarted = true
  logger.info('[Server] 启动完成')
}

/**
 * 停止Server
 */
export async function stopServer(): Promise<void> {
  if (!isStarted) {
    logger.info('[Server] Server未启动')
    return
  }
  await cleanup()
  isStarted = false
}

/**
 * 检查Server是否已启动
 */
export function isServerStarted(): boolean {
  return isStarted
}

/**
 * 判断是否为 LangChain 内部流关闭错误
 */
function isLangChainStreamError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const msg = err.message || ''
  return (
    msg.includes('Controller is already closed') ||
    msg.includes('StreamMessagesHandler') ||
    msg.includes('handleLLMNewToken') ||
    msg.includes('ReadableStream') ||
    err.name === 'InvalidStateError'
  )
}

/**
 * 注册进程事件处理器
 */
function registerProcessHandlers(): void {
  /**
   * 进程信号处理
   */
  process.on('SIGTERM', async () => {
    logger.info('[Process] 收到 SIGTERM 信号')
    await cleanup()
    process.exit(0)
  })

  process.on('SIGINT', async () => {
    logger.info('[Process] 收到 SIGINT 信号')
    await cleanup()
    process.exit(0)
  })

  process.on('uncaughtException', (error) => {
    // 忽略 LangChain 内部流关闭后的回调错误
    if (isLangChainStreamError(error)) {
      logger.debug('[Process] 忽略 LangChain 内部流关闭错误')
      return
    }
    logger.error({ error }, '[Process] 未捕获的异常')
    cleanup().then(() => process.exit(1))
  })

  process.on('unhandledRejection', (reason) => {
    // 忽略 LangChain 内部流关闭后的回调错误
    if (isLangChainStreamError(reason)) {
      logger.debug('[Process] 忽略 LangChain 内部流关闭错误')
      return
    }
    logger.error({ reason }, '[Process] 未处理的Promise拒绝')
  })
}

/**
 * 处理父进程消息（子进程模式下）
 */
function setupParentProcessCommunication(): void {
  if (!process.send) {
    return // 不是子进程模式
  }

  logger.info('[Server] 运行在子进程模式下，设置父进程通信')

  // 通知父进程已就绪
  process.send({ type: 'ready', pid: process.pid })

  // 监听父进程消息
  process.on('message', async (message: unknown) => {
    if (typeof message !== 'object' || message === null) {
      return
    }

    const msg = message as Record<string, unknown>

    switch (msg.type) {
      case 'shutdown':
        logger.info('[Server] 收到父进程关闭指令')
        await cleanup()
        process.exit(0)
        break

      case 'ping':
        process.send?.({ type: 'pong', timestamp: Date.now() })
        break

      default:
        logger.debug({ message }, '[Server] 收到父进程消息')
    }
  })

  // 父进程断开连接时的处理
  process.on('disconnect', async () => {
    logger.warn('[Server] 与父进程断开连接，准备关闭')
    await cleanup()
    process.exit(0)
  })
}

// 如果是直接运行此文件（不是被导入），则自动启动Server
if (require.main === module) {
  // 注册进程事件处理器
  registerProcessHandlers()

  // 设置父进程通信（如果是子进程模式）
  setupParentProcessCommunication()

  // 启动 Server
  startServer().catch((error) => {
    logger.error('[Server] 启动失败', error)
    process.exit(1)
  })
}
