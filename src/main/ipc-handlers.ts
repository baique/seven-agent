import { ipcMain, BrowserWindow, screen, nativeImage } from 'electron'
import http from 'node:http'
import { logger } from './utils/logger'
import { popupManager } from './core/tools/popup-manager'
import { getLive2DModelConfig, env } from './config/env'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/**
 * 获取图标路径
 * 开发环境: 使用源文件路径
 * 打包后: 使用 resources 目录下的 icon.png
 */
const getIconPath = (): string => {
  if (require('electron').app.isPackaged) {
    return join(process.resourcesPath, 'icon.png')
  }
  return join(__dirname, '../../resources/icon.png')
}
const iconPath = getIconPath()

/**
 * 获取应用图标 (nativeImage)
 */
const getAppIcon = (): Electron.NativeImage => {
  return nativeImage.createFromPath(iconPath)
}

/**
 * 向 Server 发送 HTTP 请求的辅助方法
 * 用于 Main 进程与 Server 进程之间的通信，替代直接 import Server 代码
 */
function serverFetch<T = unknown>(
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<{
  code: number
  data?: T
  error?: string
  success?: boolean
  message?: string
  [key: string]: unknown
}> {
  return new Promise((resolve) => {
    const data = options?.body ? JSON.stringify(options.body) : ''
    const req = http.request(
      {
        hostname: 'localhost',
        port: env.SOCKET_PORT,
        path,
        method: options?.method || (data ? 'POST' : 'GET'),
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString()
        })
        res.on('end', () => {
          try {
            resolve(JSON.parse(body))
          } catch {
            resolve({ code: res.statusCode ?? 500, error: body })
          }
        })
      },
    )
    req.on('error', (err) => {
      logger.error(`[ServerFetch] 请求失败: ${err.message}`)
      resolve({ code: 500, error: err.message })
    })
    if (data) req.write(data)
    req.end()
  })
}

/**
 * IPC处理器模块
 * 负责注册所有窗口管理相关的IPC命令
 * 用于UI层和主进程之间的窗口操作通信
 * 业务逻辑类操作通过 HTTP 调用 Server API，不直接 import Server 代码
 */

/**
 * 注册所有IPC处理器
 * @param mainWindow - 主窗口实例
 */
export function registerIpcHandlers(mainWindow: BrowserWindow | null): void {
  /**
   * 窗口最小化
   */
  ipcMain.on('window:minimize', () => {
    const sender = BrowserWindow.getFocusedWindow()
    sender?.minimize()
    logger.info('[IPC] 窗口最小化')
  })

  /**
   * 窗口关闭
   */
  ipcMain.on('window:close', () => {
    const sender = BrowserWindow.getFocusedWindow()
    sender?.close()
    logger.info('[IPC] 窗口关闭')
  })

  /**
   * 设置窗口置顶状态
   */
  ipcMain.handle('window:setTop', (_event, data: { alwaysOnTop: boolean }) => {
    if (!mainWindow) {
      return { success: false, error: 'Window not available' }
    }
    mainWindow.setAlwaysOnTop(data.alwaysOnTop)
    logger.info({ alwaysOnTop: data.alwaysOnTop }, '[IPC] 窗口置顶状态已更改')
    return { success: true, alwaysOnTop: data.alwaysOnTop }
  })

  /**
   * 切换窗口置顶状态
   */
  ipcMain.handle('window:toggleTop', () => {
    if (!mainWindow) {
      return { success: false, error: 'Window not available' }
    }
    const newState = !mainWindow.isAlwaysOnTop()
    mainWindow.setAlwaysOnTop(newState)
    logger.info({ alwaysOnTop: newState }, '[IPC] 窗口置顶状态已切换')
    return { success: true, alwaysOnTop: newState }
  })

  /**
   * 获取窗口状态
   */
  ipcMain.handle('window:getState', () => {
    if (!mainWindow) {
      return { success: false, error: 'Window not available' }
    }
    return { success: true, alwaysOnTop: mainWindow.isAlwaysOnTop() }
  })

  /**
   * 设置鼠标穿透
   */
  ipcMain.handle('window:setIgnoreMouse', (_event, data: { state: boolean; option?: any }) => {
    if (!mainWindow) {
      return { success: false, error: 'Window not available' }
    }
    mainWindow.setIgnoreMouseEvents(data.state, data.option)
    logger.debug({ state: data.state }, '[IPC] 鼠标穿透状态已更改')
    return { success: true, state: data.state }
  })

  /**
   * 重置窗口位置
   */
  ipcMain.handle('window:resetPosition', () => {
    if (!mainWindow) {
      return { success: false, error: 'Window not available' }
    }
    mainWindow.webContents.send('position_reset', {})
    logger.info('[IPC] 位置重置事件已发送')
    return { success: true, reset: true }
  })

  /**
   * 重新打开弹窗
   */
  ipcMain.handle(
    'popup:reopen',
    async (
      _event,
      data: {
        id: string
        title?: string
        content?: string
        width?: number
        height?: number
        x?: number
        y?: number
        popupType?: string
      },
    ) => {
      const { id, ...popupParams } = data
      if (!id) {
        return { success: false, error: 'Popup id is required' }
      }

      const window = await popupManager.reopenPopup(id, popupParams)
      if (window) {
        logger.info({ id }, '[IPC] 弹窗已重新打开')
        return { success: true, id }
      }
      return { success: false, error: 'Popup not found or cannot be reopened' }
    },
  )

  /**
   * 创建新弹窗（由AI调用触发）
   */
  ipcMain.handle(
    'popup:create',
    async (
      _event,
      data: {
        id: string
        content: string
        title: string
        x: number
        y: number
        duration: number
        popupType: string
      },
    ) => {
      try {
        const { id, content, title, x, y, duration } = data

        let finalX = x
        let finalY = y
        if (finalX === -1 || finalY === -1) {
          const primaryDisplay = screen.getPrimaryDisplay()
          const { width: screenWidth, height: screenHeight } = primaryDisplay.workArea
          if (finalX === -1) finalX = (screenWidth - 800) / 2
          if (finalY === -1) finalY = (screenHeight - 600) / 2
        }

        const { createPopupWindow } = await import('./core/tools/popup-manager')
        const popupWindow = await createPopupWindow(
          id,
          content,
          finalX,
          finalY,
          title,
          data.popupType,
        )

        if (duration > 0) {
          setTimeout(() => {
            if (!popupWindow.isDestroyed()) {
              popupWindow.close()
            }
          }, duration)
        }

        logger.info(`[IPC] 弹窗已创建: ${id}`)
        return { success: true, id }
      } catch (error: any) {
        logger.error(`[IPC] 创建弹窗失败: ${error.message}`)
        return { success: false, error: error.message }
      }
    },
  )

  // ========== 审查窗口管理 ==========

  const reviewWindows = new Map<string, BrowserWindow>()
  const reviewDataCache = new Map<
    string,
    {
      requestId: string
      toolName: string
      toolArgs: Record<string, unknown>
      riskDescription: string
      timeout: number
    }
  >()

  /**
   * 创建审查窗口
   */
  ipcMain.handle(
    'review:create',
    async (
      _event,
      data: {
        requestId: string
        toolName: string
        toolArgs: Record<string, unknown>
        riskDescription: string
        timeout: number
      },
    ) => {
      try {
        const { requestId } = data

        reviewDataCache.set(requestId, data)

        if (reviewWindows.has(requestId)) {
          const existingWindow = reviewWindows.get(requestId)
          if (existingWindow && !existingWindow.isDestroyed()) {
            existingWindow.close()
          }
          reviewWindows.delete(requestId)
        }

        const primaryDisplay = screen.getPrimaryDisplay()
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workArea
        const width = 420
        const height = 550
        const x = (screenWidth - width) / 2
        const y = (screenHeight - height) / 2

        const reviewWindow = new BrowserWindow({
          width,
          height,
          x,
          y,
          show: false,
          frame: false,
          resizable: false,
          skipTaskbar: false,
          autoHideMenuBar: true,
          transparent: true,
          backgroundColor: '#00000000',
          alwaysOnTop: true,
          icon: getAppIcon(),
          useContentSize: true,
          webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false,
            webgl: true,
            experimentalFeatures: true,
          },
        })

        // 传递 socketPort 给审查窗口，使其可直接 HTTP 调用 Server
        const queryParams = new URLSearchParams({ requestId, socketPort: String(env.SOCKET_PORT) })
        if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
          reviewWindow.loadURL(
            `${process.env['ELECTRON_RENDERER_URL']}/tool-review.html?${queryParams}`,
          )
        } else {
          reviewWindow.loadFile(join(__dirname, '../renderer/tool-review.html'), {
            query: { requestId, socketPort: String(env.SOCKET_PORT) },
          })
        }

        reviewWindow.once('ready-to-show', () => {
          reviewWindow.show()
        })

        reviewWindow.on('closed', () => {
          reviewWindows.delete(requestId)
          setTimeout(() => {
            reviewDataCache.delete(requestId)
          }, 5000)
        })

        reviewWindows.set(requestId, reviewWindow)

        logger.info(`[IPC] 审查窗口已创建: ${requestId}`)
        return { success: true, requestId }
      } catch (error: any) {
        logger.error(`[IPC] 创建审查窗口失败: ${error.message}`)
        return { success: false, error: error.message }
      }
    },
  )

  /**
   * 获取审查数据
   */
  ipcMain.handle('tool-review:getData', async (_event, requestId: string) => {
    try {
      const reviewData = reviewDataCache.get(requestId)
      if (!reviewData) {
        logger.warn(`[IPC] 未找到审查数据: ${requestId}`)
        return null
      }
      return reviewData
    } catch (error: any) {
      logger.error(`[IPC] 获取审查数据失败: ${error.message}`)
      return null
    }
  })

  /**
   * 审查响应 - 审查窗口通过 HTTP 直接发送给 Server，Main 仅负责关闭窗口
   */
  ipcMain.on('tool-review:close', (_event, requestId: string) => {
    const reviewWindow = reviewWindows.get(requestId)
    if (reviewWindow && !reviewWindow.isDestroyed()) {
      reviewWindow.close()
    }
    reviewWindows.delete(requestId)
    logger.info(`[IPC] 审查窗口已关闭: ${requestId}`)
  })

  /**
   * 获取Live2D模型配置
   */
  ipcMain.handle('model:getConfig', async () => {
    try {
      const config = getLive2DModelConfig()
      logger.info('[IPC] 获取模型配置成功')
      return config
    } catch (error: any) {
      logger.error(`[IPC] 获取模型配置失败: ${error.message}`)
      throw error
    }
  })

  // ========== 配置中心 IPC 处理器（通过 HTTP 调用 Server API） ==========

  /**
   * 获取配置中心完整配置
   */
  ipcMain.handle('settings:getConfig', async () => {
    try {
      const result = await serverFetch('/api/settings')
      if (result.code === 200) {
        logger.info('[IPC] 获取配置中心配置成功')
        return { success: true, config: result.data }
      }
      logger.error(`[IPC] 获取配置中心配置失败: ${result.error}`)
      return { success: false, error: result.error }
    } catch (error: any) {
      logger.error(`[IPC] 获取配置中心配置失败: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  /**
   * 保存工具审查白名单
   */
  ipcMain.handle('settings:saveWhitelist', async (_event, whitelist: string[]) => {
    try {
      logger.info(`[IPC] 接收到保存白名单请求，数量: ${whitelist.length}`)
      const result = await serverFetch('/api/settings/whitelist', { body: { whitelist } })
      logger.info(`[IPC] 保存白名单${result.code === 200 ? '成功' : '失败'}`)
      return { success: result.code === 200 && result.success === true }
    } catch (error: any) {
      logger.error(`[IPC] 保存工具审查白名单失败: ${error.message}`)
      return { success: false, error: error.message }
    }
  })

  /**
   * 保存工具截断配置
   */
  ipcMain.handle(
    'settings:saveTruncation',
    async (
      _event,
      config: {
        defaultMaxChars: number
        defaultMaxLines: number
        defaultMode: 'head' | 'tail' | 'summary' | 'structure'
        strategies: Record<
          string,
          { maxChars?: number; maxLines?: number; mode?: 'head' | 'tail' | 'summary' | 'structure' }
        >
      },
    ) => {
      try {
        const result = await serverFetch('/api/settings/truncation', { body: config })
        if (result.code === 200 && result.success === true) {
          logger.info('[IPC] 工具截断配置已保存')
        }
        return { success: result.code === 200 && result.success === true }
      } catch (error: any) {
        logger.error(`[IPC] 保存工具截断配置失败: ${error.message}`)
        return { success: false, error: error.message }
      }
    },
  )

  /**
   * 获取MCP服务器列表
   */
  ipcMain.handle('settings:getMCPServers', async () => {
    try {
      const result = await serverFetch('/api/mcp/servers')
      if (result.code === 200) {
        const servers = Array.isArray(result.data) ? result.data : []
        logger.info(`[IPC] 获取MCP服务器列表成功，共 ${servers.length} 个`)
        return { success: true, servers }
      }
      logger.error(`[IPC] 获取MCP服务器列表失败: ${result.error}`)
      return { success: false, error: result.error, servers: [] }
    } catch (error: any) {
      logger.error(`[IPC] 获取MCP服务器列表失败: ${error.message}`)
      return { success: false, error: error.message, servers: [] }
    }
  })

  /**
   * 刷新单个MCP服务器
   */
  ipcMain.handle('settings:refreshMCP', async (_event, serverName: string) => {
    try {
      const result = await serverFetch('/api/mcp/refresh', { body: { serverName } })
      logger.info(`[IPC] 刷新MCP服务器 ${serverName}: ${result.success ? '成功' : '失败'}`)
      return { success: result.code === 200, message: result.message, error: result.error }
    } catch (error: any) {
      logger.error(`[IPC] 刷新MCP服务器 ${serverName} 失败: ${error.message}`)
      return { success: false, message: error.message, error: error.message }
    }
  })

  /**
   * 刷新所有MCP服务器
   */
  ipcMain.handle('settings:refreshAllMCP', async () => {
    try {
      const result = await serverFetch('/api/mcp/refresh-all', { method: 'POST' })
      if (result.code === 200) {
        const results = Array.isArray(result.data) ? result.data : []
        logger.info(`[IPC] 刷新所有MCP服务器完成，共 ${results.length} 个`)
        return { success: true, results }
      }
      return { success: false, error: result.error, results: [] }
    } catch (error: any) {
      logger.error(`[IPC] 刷新所有MCP服务器失败: ${error.message}`)
      return { success: false, error: error.message, results: [] }
    }
  })

  /**
   * 获取MCP工具列表
   */
  ipcMain.handle('settings:getMCPTools', async () => {
    try {
      const result = await serverFetch('/api/mcp/tools')
      if (result.code === 200) {
        const tools = Array.isArray(result.data) ? result.data : []
        logger.info(`[IPC] 获取MCP工具列表成功，共 ${tools.length} 个`)
        return { success: true, tools }
      }
      return { success: false, error: result.error, tools: [] }
    } catch (error: any) {
      logger.error(`[IPC] 获取MCP工具列表失败: ${error.message}`)
      return { success: false, error: error.message, tools: [] }
    }
  })

  logger.info('[IPC] 所有IPC处理器已注册')
}

/**
 * 注销所有IPC处理器
 */
export function unregisterIpcHandlers(): void {
  ipcMain.removeHandler('window:setTop')
  ipcMain.removeHandler('window:toggleTop')
  ipcMain.removeHandler('window:getState')
  ipcMain.removeHandler('window:setIgnoreMouse')
  ipcMain.removeHandler('window:resetPosition')
  ipcMain.removeHandler('popup:reopen')
  ipcMain.removeHandler('model:getConfig')

  ipcMain.removeAllListeners('window:minimize')
  ipcMain.removeAllListeners('window:close')

  logger.info('[IPC] 所有IPC处理器已注销')
}
