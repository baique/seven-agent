import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  protocol,
  screen,
  dialog,
  globalShortcut,
} from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { logger } from './utils/logger'
import { getTargetDisplayId, setTargetDisplayId } from './utils/config-store'
import { getLive2DModelUrl, env } from './config/env'
import { registerIpcHandlers } from './ipc-handlers'
import { createSplashWindow, updateSplashProgress, closeSplashWindow } from './splash-window'
import { startServerProcess, stopServerProcess, waitForServerReady } from './server-process'

/**
 * 获取图标路径
 * 开发环境: 使用源文件路径
 * 打包后: 使用 resources 目录下的 icon.png
 */
const getIconPath = (): string => {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'icon.png')
  }
  return join(__dirname, '../../resources/icon.png')
}
const iconPath = getIconPath()

/**
 * 获取应用图标 (nativeImage)
 * 用于窗口和托盘
 */
const getAppIcon = (): Electron.NativeImage => {
  return nativeImage.createFromPath(iconPath)
}

/**
 * 注册 local:// 协议用于访问打包后的本地资源文件
 * 必须在 app ready 之前调用
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')
app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')
app.commandLine.appendSwitch('enable-unsafe-webgpu')
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch('use-gl', 'angle')

const socketPort = env.SOCKET_PORT

// 解析命令行参数和环境变量
const args = process.argv.slice(2)
const isUiMode = args.includes('--ui') || process.env.APP_MODE === 'ui'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let terminalWindow: BrowserWindow | null = null
let settingsWindow: BrowserWindow | null = null
let isCleaningUp = false

/**
 * 统一的资源清理函数
 */
async function cleanup(): Promise<void> {
  if (isCleaningUp) {
    logger.info('[Cleanup] 清理已在进行中，跳过重复清理')
    return
  }
  isCleaningUp = true
  logger.info('[Cleanup] 开始清理资源...')

  try {
    // 停止 Server 子进程
    await stopServerProcess()
    logger.info('[Cleanup] Server 子进程已停止')
  } catch (error) {
    logger.error({ error }, '[Cleanup] 停止 Server 子进程失败')
  }

  logger.info('[Cleanup] 资源清理完成')
}

/**
 * 获取所有显示器列表
 */
function getAllDisplays(): Electron.Display[] {
  return screen.getAllDisplays()
}

/**
 * 获取当前目标显示器
 */
function getTargetDisplay(): Electron.Display | null {
  const displays = getAllDisplays()
  const targetId = getTargetDisplayId()

  if (targetId !== null) {
    const target = displays.find((d) => d.id === targetId)
    if (target) return target
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  if (displays.length > 1) {
    const secondaryDisplay = displays.find((d) => d.id !== primaryDisplay.id)
    if (secondaryDisplay) return secondaryDisplay
  }

  return primaryDisplay
}

/**
 * 获取当前显示器名称
 */
function getCurrentDisplayName(): string {
  const displays = getAllDisplays()
  const targetId = getTargetDisplayId()
  const primaryDisplay = screen.getPrimaryDisplay()

  if (targetId === null) {
    if (displays.length > 1) {
      return '副屏幕（默认）'
    }
    return '主屏幕'
  }

  const target = displays.find((d) => d.id === targetId)
  if (target) {
    const isPrimary = target.id === primaryDisplay.id
    return isPrimary ? '主屏幕' : `屏幕 ${displays.indexOf(target) + 1}`
  }

  return '副屏幕（默认）'
}

/**
 * 切换到下一个显示器
 */
function switchToNextDisplay(): void {
  const displays = getAllDisplays()
  if (displays.length <= 1) {
    logger.info('[Display] 只有一个显示器，无法切换')
    return
  }

  const primaryDisplay = screen.getPrimaryDisplay()
  const currentTargetId = getTargetDisplayId()

  let currentIndex = -1
  if (currentTargetId === null) {
    const secondaryDisplay = displays.find((d) => d.id !== primaryDisplay.id)
    currentIndex = secondaryDisplay ? displays.indexOf(secondaryDisplay) : 0
  } else {
    currentIndex = displays.findIndex((d) => d.id === currentTargetId)
  }

  const nextIndex = (currentIndex + 1) % displays.length
  const nextDisplay = displays[nextIndex]

  if (nextDisplay.id === primaryDisplay.id && displays.length > 1) {
    const secondaryDisplay = displays.find((d) => d.id !== primaryDisplay.id)
    if (secondaryDisplay && nextIndex === 0) {
      setTargetDisplayId(null)
      moveToDisplay(secondaryDisplay)
      logger.info('[Display] 切换到副屏幕（默认）')
    } else {
      setTargetDisplayId(nextDisplay.id)
      moveToDisplay(nextDisplay)
      logger.info(`[Display] 切换到主屏幕`)
    }
  } else {
    const secondaryDisplay = displays.find((d) => d.id !== primaryDisplay.id)
    if (secondaryDisplay && nextDisplay.id === secondaryDisplay.id) {
      setTargetDisplayId(null)
    } else {
      setTargetDisplayId(nextDisplay.id)
    }
    moveToDisplay(nextDisplay)
    logger.info(`[Display] 切换到屏幕 ${nextIndex + 1}`)
  }

  updateTrayMenu()
}

/**
 * 将窗口移动到指定显示器
 */
function moveToDisplay(display: Electron.Display): void {
  if (!mainWindow) return
  const { x, y, width, height } = display.workArea
  mainWindow.setBounds({ x, y, width, height })
}

/**
 * 更新托盘菜单
 */
function updateTrayMenu(): void {
  if (!tray) return

  const displays = getAllDisplays()
  const switchLabel =
    displays.length > 1 ? `切换屏幕 (${getCurrentDisplayName()})` : '切换屏幕（仅一个显示器）'

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '重置位置',
      click: () => {
        mainWindow?.webContents.send('position-reset')
      },
    },
    {
      label: switchLabel,
      enabled: displays.length > 1,
      click: () => {
        switchToNextDisplay()
      },
    },
    { type: 'separator' },
    {
      label: '调试窗口',
      click: () => {
        mainWindow?.webContents.openDevTools()
      },
    },
    { type: 'separator' },
    {
      label: '终端管理',
      click: () => {
        createTerminalWindow()
      },
    },
    {
      label: '配置中心',
      click: () => {
        createSettingsWindow()
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
}

function createTray(): void {
  const trayIcon = getAppIcon().resize({ width: 16, height: 16 })
  tray = new Tray(trayIcon)

  tray.setToolTip('77')
  updateTrayMenu()
}

/**
 * 创建终端管理窗口
 */
function createTerminalWindow(): void {
  if (terminalWindow && !terminalWindow.isDestroyed()) {
    terminalWindow.show()
    terminalWindow.focus()
    return
  }

  terminalWindow = new BrowserWindow({
    width: 900,
    height: 700,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: false,
    autoHideMenuBar: true,
    alwaysOnTop: false,
    type: 'normal',
    title: '终端管理',
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webgl: true,
      experimentalFeatures: true,
      allowRunningInsecureContent: true,
      webSecurity: false,
      contextIsolation: false,
    },
  })

  terminalWindow.on('ready-to-show', () => {
    terminalWindow?.show()
  })

  terminalWindow.on('closed', () => {
    terminalWindow = null
  })

  // 加载终端管理页面
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    terminalWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/terminal.html')
  } else {
    terminalWindow.loadFile(join(__dirname, '../renderer/terminal.html'))
  }

  logger.info('[Terminal] 终端管理窗口已创建')
}

/**
 * 创建配置中心窗口
 */
function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: 1000,
    height: 800,
    show: false,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: false,
    autoHideMenuBar: true,
    alwaysOnTop: false,
    type: 'normal',
    title: '配置中心',
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webgl: true,
      experimentalFeatures: true,
      contextIsolation: true,
    },
  })

  settingsWindow.on('ready-to-show', () => {
    settingsWindow?.show()
  })

  settingsWindow.on('closed', () => {
    settingsWindow = null
  })

  // 加载配置中心页面
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    settingsWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/settings.html')
  } else {
    settingsWindow.loadFile(join(__dirname, '../renderer/settings.html'))
  }

  logger.info('[Settings] 配置中心窗口已创建')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    show: false,
    autoHideMenuBar: true,
    frame: false,
    transparent: true,
    resizable: true,
    hasShadow: false,
    alwaysOnTop: false,
    skipTaskbar: true,
    type: 'toolbar',
    backgroundColor: '#00000000',
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webgl: true,
      experimentalFeatures: true,
    },
  })

  // 注册 IPC 处理器
  registerIpcHandlers(mainWindow)

  ipcMain.on('open-terminal-manager', () => createTerminalWindow())

  mainWindow.on('ready-to-show', () => {
    const targetDisplay = getTargetDisplay()

    if (targetDisplay) {
      const { x, y, width, height } = targetDisplay.workArea
      mainWindow?.setBounds({ x, y, width, height })
      logger.info(
        { display: targetDisplay.id, workArea: targetDisplay.workArea },
        `窗口已设置到目标屏幕`,
      )
    } else {
      mainWindow?.maximize()
    }
    mainWindow?.setResizable(false)
    mainWindow?.setSkipTaskbar(true)
    mainWindow?.show()
  })

  // 主窗口关闭时直接退出程序
  mainWindow.on('closed', () => {
    logger.info('[MainWindow] 主窗口已关闭，退出程序')
    app.quit()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow?.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?port=${socketPort}`)
  } else {
    mainWindow?.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/**
 * 启动UI模式
 * 创建UI窗口，连接已存在的Server
 */
async function startUiMode(): Promise<void> {
  logger.info('[App] 启动UI模式')

  // 显示启动窗口
  createSplashWindow()
  updateSplashProgress('init', 10)

  // 模拟启动步骤
  await new Promise((resolve) => setTimeout(resolve, 300))
  updateSplashProgress('connect', 30, '正在连接服务...')

  await new Promise((resolve) => setTimeout(resolve, 400))
  updateSplashProgress('workspace', 50, '正在加载工作区...')

  await new Promise((resolve) => setTimeout(resolve, 300))
  updateSplashProgress('memory', 70, '正在恢复对话历史...')

  // 创建主窗口（此时启动窗口仍然显示）
  createWindow()
  createTray()

  // 注册全局快捷键
  registerGlobalShortcuts()

  // 等待模型加载完成
  updateSplashProgress('complete', 95, '正在加载模型...')
  await waitForModelLoaded()

  // 关闭启动窗口
  await closeSplashWindow()
}

/**
 * 等待模型加载完成
 */
function waitForModelLoaded(): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      logger.warn('[App] 等待模型加载超时，继续关闭启动窗口')
      resolve()
    }, 30000) // 30秒超时

    ipcMain.once('model:loaded', () => {
      clearTimeout(timeout)
      logger.info('[App] 模型加载完成，准备关闭启动窗口')
      resolve()
    })
  })
}

/**
 * 启动集成模式
 * 同时启动Server（子进程）和UI
 */
async function startIntegratedMode(): Promise<void> {
  logger.info('[App] 启动集成模式（Server 在子进程中运行）')

  // 显示启动窗口
  createSplashWindow()
  updateSplashProgress('init', 5)

  // 先启动 Server 子进程
  updateSplashProgress('server', 20, '正在启动核心服务...')
  const serverStarted = await startServerProcess()
  if (!serverStarted) {
    throw new Error('Server 子进程启动失败')
  }

  // 等待 Server 就绪（通过 HTTP 健康检查）
  updateSplashProgress('connect', 40, '正在建立连接...')
  const serverReady = await waitForServerReady(
    env.SOCKET_PORT,
    60000, // 60秒超时
    (attempt, maxAttempts) => {
      const progress = 40 + Math.floor((attempt / maxAttempts) * 20)
      updateSplashProgress('connect', progress, `正在建立连接...(${attempt}/${maxAttempts})`)
    },
  )

  if (!serverReady) {
    throw new Error('Server 健康检查超时，无法建立连接')
  }

  updateSplashProgress('workspace', 60, '正在初始化工作空间...')
  await new Promise((resolve) => setTimeout(resolve, 300))

  updateSplashProgress('memory', 80, '正在加载历史记忆...')
  await new Promise((resolve) => setTimeout(resolve, 400))

  // 再启动UI（此时启动窗口仍然显示）
  createWindow()
  createTray()

  // 注册全局快捷键
  registerGlobalShortcuts()

  // 等待模型加载完成
  updateSplashProgress('complete', 95, '正在加载模型...')
  await waitForModelLoaded()

  // 关闭启动窗口
  await closeSplashWindow()
}

/**
 * 注册全局快捷键
 */
function registerGlobalShortcuts(): void {
  const last7Time = { value: 0 }
  const HOTKEY_INTERVAL = 500

  globalShortcut.register('CommandOrControl+7', () => {
    const now = Date.now()
    const isDoublePress = now - last7Time.value < HOTKEY_INTERVAL

    mainWindow?.show()
    mainWindow?.focus()

    if (isDoublePress) {
      const newState = !mainWindow?.isAlwaysOnTop()
      mainWindow?.setAlwaysOnTop(newState)
      mainWindow?.webContents.send('window-state-changed', { alwaysOnTop: newState })
      logger.info({ alwaysOnTop: newState }, '[GlobalShortcut] Ctrl+7 快速双击，toggle窗口')
    } else {
      logger.info('[GlobalShortcut] Ctrl+7 单击，唤起窗口')
    }

    mainWindow?.webContents.send('toggle-character-visibility', { hidden: false })
    logger.info('[GlobalShortcut] Ctrl+7 显示人物和跟随面板')

    mainWindow?.webContents.send('focus-input')

    last7Time.value = now
  })

  globalShortcut.register('CommandOrControl+Shift+7', () => {
    mainWindow?.webContents.send('toggle-character-visibility', { hidden: true })
    logger.info('[GlobalShortcut] Ctrl+Shift+7 隐藏人物和跟随面板')
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.electron')

  /**
   * 注册 local:// 协议处理器
   */
  protocol.registerFileProtocol('local', (request, callback) => {
    const url = request.url.slice('local://'.length)
    const basePath = app.isPackaged ? process.resourcesPath : join(__dirname, '../../..')
    const filePath = join(basePath, url)
    logger.info(`[Protocol] local:// request: ${request.url} -> ${filePath}`)
    callback(filePath)
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.on('ping', () => console.log('pong'))

  ipcMain.handle('getInfo', () => {
    const modelUrl = getLive2DModelUrl()
    logger.info(
      `[getInfo] isPackaged: ${app.isPackaged}, resourcesPath: ${process.resourcesPath}, modelUrl: ${modelUrl}`,
    )
    return {
      socketPort,
      live2dModelUrl: modelUrl,
    }
  })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // 根据模式启动
  try {
    if (isUiMode) {
      await startUiMode()
    } else {
      await startIntegratedMode()
    }
  } catch (error) {
    logger.error({ error }, '[App] 启动失败')
    dialog.showErrorBox('启动错误', `应用启动失败: ${error}`)
    app.quit()
  }
})

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function getWindowAlwaysOnTop(): boolean {
  return mainWindow?.isAlwaysOnTop() ?? false
}

export function setWindowAlwaysOnTop(alwaysOnTop: boolean): void {
  mainWindow?.setAlwaysOnTop(alwaysOnTop)
}

/**
 * 应用退出前的清理事件
 */
app.on('before-quit', async (event) => {
  event.preventDefault()
  await cleanup()
  app.exit(0)
})

/**
 * 窗口全部关闭事件
 */
app.on('window-all-closed', async () => {
  await cleanup()
  app.quit()
})

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
