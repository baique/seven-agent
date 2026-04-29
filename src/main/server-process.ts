import { spawn, ChildProcess, exec } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import { logger } from './utils/logger'
import { env } from './config/env'
import http from 'http'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * Server 子进程管理器
 * 负责在主进程中管理 Server 子进程的生命周期
 */

/** 子进程实例 */
let serverProcess: ChildProcess | null = null

/** 是否正在启动中 */
let isStarting = false

/** 是否正在停止中 */
let isStopping = false

/** 自动重启次数 */
let restartCount = 0

/** 最大自动重启次数 */
const MAX_RESTART_COUNT = 5

/** 重启间隔（毫秒） */
const RESTART_INTERVAL = 5000

/**
 * 检查是否启用强制模式
 */
function isForceMode(): boolean {
  return process.env.SERVER_FORCE_MODE === 'true'
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
    logger.info(`[ServerProcess] 已强制结束进程 PID: ${pid}`)
  } catch (error) {
    logger.error({ error }, `[ServerProcess] 结束进程 PID: ${pid} 失败`)
    throw error
  }
}

/**
 * 强制释放端口
 * 查找并结束占用指定端口的进程
 * @param port 端口号
 */
async function forceReleasePort(port: number): Promise<void> {
  logger.info(`[ServerProcess] 正在强制释放端口 ${port}...`)

  // 等待一小段时间让端口释放
  await new Promise((resolve) => setTimeout(resolve, 500))

  // 查找并结束进程
  const pid = await getProcessOnPort(port)
  if (pid) {
    logger.info(`[ServerProcess] 发现占用端口 ${port} 的进程 PID: ${pid}`)
    await killProcess(pid)

    // 等待进程结束
    let attempts = 0
    const maxAttempts = 10
    while (attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const isRunning = await checkServerHealth(port)
      if (!isRunning) {
        logger.info(`[ServerProcess] 端口 ${port} 已成功释放`)
        return
      }
      attempts++
    }
    throw new Error(`无法释放端口 ${port}，进程可能未响应`)
  } else {
    logger.warn(`[ServerProcess] 无法找到占用端口 ${port} 的进程`)
  }
}

/**
 * 获取 setting.json 配置路径
 * 与 ipc-handlers.ts 中的逻辑保持一致
 */
function getSettingConfigPath(): string {
  const isPackaged = app.isPackaged
  if (isPackaged) {
    return join(process.resourcesPath, 'setting.json')
  }
  return join(app.getAppPath(), 'setting.json')
}

/**
 * 获取 Server 启动配置
 * 开发模式: 使用 tsx 直接运行 TypeScript 源码
 * 生产模式: 使用 node 运行编译后的 JavaScript
 */
function getServerLaunchConfig(): {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
} {
  const isPackaged = app.isPackaged

  // 基础环境变量
  const baseEnv = {
    ...process.env,
    SERVER_MODE: 'child_process',
    NODE_ENV: isPackaged ? 'production' : 'development',
    ELECTRON_IS_PACKAGED: isPackaged ? 'true' : 'false',
  }

  // 检查是否启用强制模式
  const forceMode = process.env.SERVER_FORCE_MODE === 'true'
  if (forceMode) {
    logger.info('[ServerProcess] 强制模式已启用，将强制结束占用端口的进程')
  }

  if (isPackaged) {
    // 生产模式: 使用编译后的 JS 文件
    // Server 代码在 app.asar.unpacked 中，因为需要 Node.js 直接执行
    const serverJsPath = join(
      process.resourcesPath,
      'app.asar.unpacked',
      'out',
      'server',
      'index.js',
    )

    logger.info(`[ServerProcess] 生产模式，Server路径: ${serverJsPath}`)

    return {
      command: 'node',
      args: [serverJsPath],
      cwd: process.resourcesPath,
      env: {
        ...baseEnv,
        // 传递关键配置给子进程，避免子进程重复读取 .env
        SOCKET_PORT: String(env.SOCKET_PORT),
        WORKSPACE: process.env.WORKSPACE || '',
        // 传递 setting.json 的绝对路径，确保主进程和子进程使用同一文件
        SETTING_JSON_PATH: getSettingConfigPath(),
        // 传递 resources 路径，方便子进程计算其他路径
        RESOURCES_PATH: process.resourcesPath,
        // 传递强制模式标志
        SERVER_FORCE_MODE: forceMode ? 'true' : 'false',
      },
    }
  } else {
    // 开发模式: 使用 tsx 直接运行 TypeScript
    const projectRoot = join(__dirname, '../..')
    const serverEntry = join(projectRoot, 'src', 'server', 'index.ts')

    logger.info(`[ServerProcess] 开发模式，Server入口: ${serverEntry}`)

    return {
      command: 'npx',
      args: ['tsx', serverEntry],
      cwd: projectRoot,
      env: {
        ...baseEnv,
        // 开发模式下也传递 setting.json 路径
        SETTING_JSON_PATH: getSettingConfigPath(),
        // 传递强制模式标志
        SERVER_FORCE_MODE: forceMode ? 'true' : 'false',
      },
    }
  }
}

/**
 * 获取 Server 子进程实例
 */
export function getServerProcess(): ChildProcess | null {
  return serverProcess
}

/**
 * 检查 Server 子进程是否正在运行
 */
export function isServerRunning(): boolean {
  return serverProcess !== null && !serverProcess.killed && serverProcess.exitCode === null
}

/**
 * 发送 HTTP 请求检测 Server 是否就绪
 * @param port 端口号
 * @param timeout 请求超时时间（毫秒）
 */
function checkServerHealth(port: number, timeout = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/health`, (res) => {
      if (res.statusCode === 200) {
        resolve(true)
      } else {
        resolve(false)
      }
    })

    req.on('error', () => {
      resolve(false)
    })

    req.setTimeout(timeout, () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * 等待 Server 就绪（通过 HTTP 健康检查）
 * @param port 端口号
 * @param timeout 总超时时间（毫秒）
 * @param onProgress 进度回调
 */
export async function waitForServerReady(
  port: number,
  timeout = 60000,
  onProgress?: (attempt: number, maxAttempts: number) => void,
): Promise<boolean> {
  const checkInterval = 1000 // 每秒检查一次
  const maxAttempts = Math.ceil(timeout / checkInterval)

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const isReady = await checkServerHealth(port)
      if (isReady) {
        logger.info(`[ServerProcess] Server 健康检查通过（第 ${attempt} 次尝试）`)
        return true
      }
    } catch (error) {
      // 忽略错误，继续等待
    }

    onProgress?.(attempt, maxAttempts)
    await new Promise((resolve) => setTimeout(resolve, checkInterval))
  }

  logger.warn(`[ServerProcess] Server 健康检查超时（${timeout}ms）`)
  return false
}

/**
 * 启动 Server 子进程
 * @returns Promise 启动成功返回 true
 */
export async function startServerProcess(): Promise<boolean> {
  if (isStarting) {
    logger.warn('[ServerProcess] Server 正在启动中，跳过重复启动')
    return false
  }

  if (isServerRunning()) {
    logger.info('[ServerProcess] Server 已经在运行中')
    return true
  }

  // 检查外部是否已启动 server
  const port = Number(env.SOCKET_PORT) || 3000
  const isExternalServerRunning = await checkServerHealth(port)
  if (isExternalServerRunning) {
    if (isForceMode()) {
      logger.info('[ServerProcess] 检测到外部 Server 已启动，强制模式启用，尝试结束占用进程')
      try {
        await forceReleasePort(port)
        // 等待端口释放
        await new Promise((resolve) => setTimeout(resolve, 1000))
      } catch (error) {
        logger.error({ error }, '[ServerProcess] 强制释放端口失败')
        return false
      }
    } else {
      logger.info('[ServerProcess] 检测到外部 Server 已启动，跳过启动')
      return true
    }
  }

  isStarting = true
  restartCount = 0

  try {
    logger.info('[ServerProcess] 正在启动 Server 子进程...')

    // 获取启动配置（根据开发/生产环境自动选择）
    const { command, args, cwd, env: childEnv } = getServerLaunchConfig()

    logger.info(`[ServerProcess] 命令: ${command} ${args.join(' ')}`)
    logger.info(`[ServerProcess] 工作目录: ${cwd}`)
    logger.info(
      `[ServerProcess] 环境: NODE_ENV=${childEnv.NODE_ENV}, SERVER_MODE=${childEnv.SERVER_MODE}`,
    )

    serverProcess = spawn(command, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      shell: process.platform === 'win32',
      cwd,
    })

    logger.info(`[ServerProcess] Server 子进程已创建，PID: ${serverProcess.pid}`)

    // 转发子进程 stdout 到主进程日志
    serverProcess.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      lines.forEach((line) => {
        if (line.trim()) {
          logger.info(`[Server] ${line}`)
        }
      })
    })

    // 转发子进程 stderr 到主进程日志
    serverProcess.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().trim().split('\n')
      lines.forEach((line) => {
        if (line.trim()) {
          logger.error(`[Server] ${line}`)
        }
      })
    })

    // 监听子进程退出
    serverProcess.on('exit', (code, signal) => {
      logger.info(`[ServerProcess] Server 子进程退出，code: ${code}, signal: ${signal}`)
      serverProcess = null
      isStarting = false

      // 非主动停止且退出码非 0，尝试自动重启
      if (!isStopping && code !== 0 && restartCount < MAX_RESTART_COUNT) {
        restartCount++
        logger.info(`[ServerProcess] ${RESTART_INTERVAL}ms 后尝试第 ${restartCount} 次自动重启...`)
        setTimeout(() => {
          startServerProcess().catch((error) => {
            logger.error({ error }, '[ServerProcess] 自动重启失败')
          })
        }, RESTART_INTERVAL)
      }
    })

    // 监听子进程错误
    serverProcess.on('error', (error) => {
      logger.error({ error }, '[ServerProcess] Server 子进程错误')
    })

    logger.info('[ServerProcess] Server 子进程启动成功（正在等待健康检查）')
    isStarting = false
    return true
  } catch (error) {
    logger.error({ error }, '[ServerProcess] 启动 Server 子进程失败')
    isStarting = false
    serverProcess = null
    throw error
  }
}

/**
 * 停止 Server 子进程
 */
export async function stopServerProcess(): Promise<void> {
  if (!serverProcess || serverProcess.killed) {
    logger.info('[ServerProcess] Server 未在运行')
    serverProcess = null
    return
  }

  isStopping = true
  const pid = serverProcess.pid
  logger.info(`[ServerProcess] 正在停止 Server 子进程 (PID: ${pid})...`)

  try {
    // Windows 上使用 taskkill 终止进程树
    if (process.platform === 'win32' && pid) {
      // 先尝试优雅终止 (/T 表示终止进程树)
      const { exec } = await import('child_process')
      await new Promise<void>((resolve) => {
        exec(`taskkill /PID ${pid} /T`, (error) => {
          if (error) {
            logger.warn(`[ServerProcess] taskkill 失败: ${error.message}`)
          }
          resolve()
        })

        // 3秒后强制终止
        setTimeout(() => {
          exec(`taskkill /F /PID ${pid} /T`, () => resolve())
        }, 3000)
      })
    } else {
      // Unix 系统使用 kill
      serverProcess.kill('SIGTERM')

      // 等待 3 秒后强制终止
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          if (isServerRunning()) {
            serverProcess?.kill('SIGKILL')
          }
          resolve()
        }, 3000)
      })
    }

    // 等待进程退出
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!isServerRunning()) {
          clearInterval(checkInterval)
          resolve()
        }
      }, 100)

      // 最多等待 5 秒
      setTimeout(() => {
        clearInterval(checkInterval)
        resolve()
      }, 5000)
    })
  } catch (error) {
    logger.error({ error }, '[ServerProcess] 停止 Server 子进程时出错')
  } finally {
    serverProcess = null
    isStopping = false
    restartCount = 0
    logger.info('[ServerProcess] Server 子进程已停止')
  }
}

/**
 * 重启 Server 子进程
 */
export async function restartServerProcess(): Promise<boolean> {
  logger.info('[ServerProcess] 正在重启 Server 子进程...')
  await stopServerProcess()
  return startServerProcess()
}
