/**
 * 启动加载窗口管理模块
 * 负责创建和管理应用启动时的加载窗口
 */
import { BrowserWindow, app, nativeImage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { logger } from './utils/logger'

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

/**
 * 获取应用图标 (nativeImage)
 */
const getAppIcon = (): Electron.NativeImage => {
  return nativeImage.createFromPath(getIconPath())
}

let splashWindow: BrowserWindow | null = null

/**
 * 启动步骤定义
 */
export type SplashStep = 'init' | 'server' | 'connect' | 'workspace' | 'memory' | 'complete'

/**
 * 启动步骤配置
 */
export interface SplashStepConfig {
  id: SplashStep
  label: string
  description: string
}

/**
 * 启动步骤列表
 */
export const SPLASH_STEPS: SplashStepConfig[] = [
  { id: 'init', label: '初始化', description: '正在准备启动环境...' },
  { id: 'server', label: '启动服务器', description: '正在启动核心服务...' },
  { id: 'connect', label: '连接服务', description: '正在建立连接...' },
  { id: 'workspace', label: '初始化工作空间', description: '正在加载工作区...' },
  { id: 'memory', label: '加载历史记忆', description: '正在恢复对话历史...' },
  { id: 'complete', label: '准备就绪', description: '即将进入主界面...' },
]

/**
 * 创建启动加载窗口
 */
export function createSplashWindow(): BrowserWindow {
  if (splashWindow && !splashWindow.isDestroyed()) {
    return splashWindow
  }

  splashWindow = new BrowserWindow({
    width: 600,
    height: 400,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: false,
    alwaysOnTop: false,
    backgroundColor: '#00000000',
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 居中显示
  splashWindow.center()

  // 加载启动页面
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    splashWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/splash.html')
  } else {
    splashWindow.loadFile(join(__dirname, '../renderer/splash.html'))
  }

  splashWindow.on('ready-to-show', () => {
    splashWindow?.show()
    logger.info('[Splash] 启动窗口已显示')
  })

  splashWindow.on('closed', () => {
    splashWindow = null
  })

  return splashWindow
}

/**
 * 更新启动进度
 * @param step - 当前步骤
 * @param progress - 进度百分比 (0-100)
 * @param message - 可选的自定义消息
 */
export function updateSplashProgress(step: SplashStep, progress: number, message?: string): void {
  if (!splashWindow || splashWindow.isDestroyed()) {
    return
  }

  const stepConfig = SPLASH_STEPS.find((s) => s.id === step)
  const data = {
    step,
    progress: Math.min(100, Math.max(0, progress)),
    label: stepConfig?.label || step,
    description: message || stepConfig?.description || '',
  }

  splashWindow.webContents.send('splash:progress', data)
  logger.info(`[Splash] 进度更新: ${step} (${progress}%) - ${data.description}`)
}

/**
 * 关闭启动窗口
 * @param fadeOut - 是否先淡出再关闭
 */
export async function closeSplashWindow(fadeOut = false): Promise<void> {
  if (!splashWindow || splashWindow.isDestroyed()) {
    return
  }

  if (fadeOut) {
    // 发送淡出命令
    splashWindow.webContents.send('splash:fade-out')

    // 等待淡出动画完成
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  splashWindow.close()
  splashWindow = null
  logger.info('[Splash] 启动窗口已关闭')
}

/**
 * 获取启动窗口实例
 */
export function getSplashWindow(): BrowserWindow | null {
  return splashWindow
}

/**
 * 检查启动窗口是否可见
 */
export function isSplashVisible(): boolean {
  return splashWindow !== null && !splashWindow.isDestroyed() && splashWindow.isVisible()
}
