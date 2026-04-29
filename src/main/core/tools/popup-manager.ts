import { BrowserWindow, screen, app, nativeImage } from 'electron'
import { logger } from '../../utils/logger'
import { join } from 'path'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import MarkdownIt from 'markdown-it'

/**
 * 获取应用图标 (nativeImage)
 * 与托盘区使用相同的图标源，保持统一
 */
const getAppIcon = (): Electron.NativeImage => {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../../../resources/icon.png')
  return nativeImage.createFromPath(iconPath)
}

/**
 * Markdown 渲染器
 */
const md = new MarkdownIt({
  html: true,
  xhtmlOut: false,
  breaks: true,
  linkify: true,
  typographer: true,
})

/**
 * 弹窗信息接口
 */
interface PopupInfo {
  id: string
  window: BrowserWindow
  width: number
  height: number
  x: number
  y: number
  closed: boolean
  title: string
  content: string
  popupType: string
}

/**
 * HTML 临时文件映射表
 */
const htmlTempFiles = new Map<string, string>()

/**
 * 生成通知类型弹窗HTML（支持Markdown）
 */
function generateNotificationHtml(title: string, content: string): string {
  // 将 Markdown 渲染为 HTML
  const htmlContent = md.render(content)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #ffffff;
      padding: 15px;
      font-size: 14px;
      line-height: 1.6;
      color: #333;
    }
    h1, h2, h3, h4, h5, h6 {
      margin: 12px 0 8px;
      font-weight: 600;
      line-height: 1.4;
    }
    h1 { font-size: 18px; }
    h2 { font-size: 16px; }
    h3 { font-size: 15px; }
    p {
      margin: 8px 0;
    }
    ul, ol {
      margin: 8px 0;
      padding-left: 20px;
    }
    li {
      margin: 4px 0;
    }
    code {
      background: #f5f5f5;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Consolas', 'Monaco', monospace;
      font-size: 12px;
    }
    pre {
      background: #f5f5f5;
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 10px 0;
    }
    pre code {
      background: none;
      padding: 0;
    }
    blockquote {
      border-left: 4px solid #ddd;
      padding-left: 12px;
      margin: 10px 0;
      color: #666;
    }
    a {
      color: #0066cc;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 10px 0;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 8px;
      text-align: left;
    }
    th {
      background: #f5f5f5;
      font-weight: 600;
    }
    img {
      max-width: 100%;
      height: auto;
    }
    hr {
      border: none;
      border-top: 1px solid #ddd;
      margin: 15px 0;
    }
  </style>
</head>
<body>
  ${htmlContent}
</body>
</html>`
}

/**
 * 生成报告类型弹窗HTML（支持HTML/CSS/JS）
 */
function generateReportHtml(title: string, content: string): string {
  // 如果内容已经包含完整的 HTML 结构，直接返回
  if (
    content.trim().toLowerCase().startsWith('<!doctype') ||
    content.trim().toLowerCase().startsWith('<html')
  ) {
    return content
  }

  // 否则包装成完整 HTML
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(title)}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #ffffff;
      padding: 15px;
    }
  </style>
</head>
<body>
  ${content}
</body>
</html>`
}

/**
 * HTML 转义函数
 */
function escapeHtml(text: string): string {
  const div: Record<string, string> = {
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&#x27;',
  }
  return text.replace(/[<>&"']/g, (c) => div[c] || c)
}

/**
 * 创建临时HTML文件
 */
async function createTempHtmlFile(id: string, html: string): Promise<string> {
  const tempFile = join(tmpdir(), `popup_${id}_${randomUUID()}.html`)
  await writeFile(tempFile, html, 'utf-8')
  htmlTempFiles.set(id, tempFile)
  return tempFile
}

/**
 * 清理临时HTML文件
 */
async function cleanupTempFile(id: string): Promise<void> {
  const tempFile = htmlTempFiles.get(id)
  if (tempFile) {
    try {
      await unlink(tempFile)
      htmlTempFiles.delete(id)
    } catch {
      // 忽略清理错误
    }
  }
}

class PopupManager {
  private popups: Map<string, PopupInfo> = new Map()

  get size(): number {
    return this.popups.size
  }

  has(id: string): boolean {
    return this.popups.has(id)
  }

  get(id: string): BrowserWindow | undefined {
    return this.popups.get(id)?.window
  }

  /**
   * 获取弹窗信息（包括已关闭的）
   */
  getInfo(id: string): PopupInfo | undefined {
    return this.popups.get(id)
  }

  register(
    id: string,
    window: BrowserWindow,
    width = 250,
    height = 100,
    x?: number,
    y?: number,
    title = '通知',
    content = '',
    popupType = 'notification',
  ): void {
    const bounds = window.getBounds()
    this.popups.set(id, {
      id,
      window,
      width: width || bounds.width,
      height: height || bounds.height,
      x: x ?? bounds.x,
      y: y ?? bounds.y,
      closed: false,
      title,
      content,
      popupType,
    })

    window.on('closed', () => {
      this.markClosed(id)
    })

    logger.info(`[PopupManager] 注册弹窗: ${id}, 当前数量: ${this.popups.size}`)
  }

  /**
   * 标记弹窗为已关闭
   */
  markClosed(id: string): void {
    const popup = this.popups.get(id)
    if (popup) {
      popup.closed = true
      logger.info(`[PopupManager] 弹窗已关闭: ${id}`)
    }
  }

  remove(id: string): void {
    const popup = this.popups.get(id)
    if (popup) {
      this.popups.delete(id)
      logger.info(`[PopupManager] 移除弹窗: ${id}, 当前数量: ${this.popups.size}`)
    }
  }

  /**
   * 重新打开已关闭的弹窗
   */
  async reopenPopup(
    id: string,
    params?: {
      title?: string
      content?: string
      x?: number
      y?: number
      popupType?: string
    },
  ): Promise<BrowserWindow | null> {
    const popup = this.popups.get(id)

    if (popup && !popup.closed && !popup.window.isDestroyed()) {
      popup.window.show()
      popup.window.focus()
      return popup.window
    }

    try {
      const popupType = params?.popupType ?? popup?.popupType ?? 'notification'
      const title = params?.title ?? popup?.title ?? '通知'
      const content = params?.content ?? popup?.content ?? ''

      let finalX: number | undefined
      let finalY: number | undefined

      if (params?.x !== undefined) finalX = params.x
      if (params?.y !== undefined) finalY = params.y

      if (finalX === -1 || finalY === -1) {
        const primaryDisplay = screen.getPrimaryDisplay()
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workArea
        if (finalX === -1) finalX = (screenWidth - 800) / 2
        if (finalY === -1) finalY = (screenHeight - 600) / 2
      }

      const window = new BrowserWindow({
        width: 800,
        height: 600,
        x: finalX,
        y: finalY,
        title,
        show: false,
        frame: true,
        resizable: true,
        skipTaskbar: false,
        autoHideMenuBar: true,
        transparent: false,
        backgroundColor: '#ffffff',
        icon: getAppIcon(),
        webPreferences: {
          preload: join(__dirname, '../../../out/preload/index.js'),
          sandbox: false,
        },
      })

      window.on('closed', () => {
        this.markClosed(id)
        cleanupTempFile(id)
      })

      // 根据弹窗类型生成HTML
      const htmlContent =
        popupType === 'report'
          ? generateReportHtml(title, content)
          : generateNotificationHtml(title, content)

      const tempFile = await createTempHtmlFile(id, htmlContent)
      const fileUrl = pathToFileURL(tempFile).href
      await window.loadURL(fileUrl)
      window.show()

      if (popup) {
        popup.window = window
        popup.closed = false
        popup.title = title
        popup.content = content
        popup.popupType = popupType
      } else {
        this.popups.set(id, {
          id,
          window,
          width: 800,
          height: 600,
          x: finalX ?? 0,
          y: finalY ?? 0,
          closed: false,
          title,
          content,
          popupType,
        })
      }

      logger.info(`[PopupManager] 重新打开弹窗: ${id}, type=${popupType}`)
      return window
    } catch (error) {
      logger.error(`[PopupManager] 重新打开弹窗失败: ${id}, ${error}`)
      return null
    }
  }

  activate(id: string): boolean {
    const popup = this.popups.get(id)
    if (!popup) {
      return false
    }

    const { window } = popup
    if (!window.isDestroyed()) {
      window.show()
      window.focus()
      logger.info(`[PopupManager] 激活弹窗: ${id}`)
      return true
    }

    return false
  }

  getAll(): Map<string, PopupInfo> {
    return this.popups
  }

  clear(): void {
    for (const popup of this.popups.values()) {
      if (!popup.closed && !popup.window.isDestroyed()) {
        popup.window.close()
      }
    }
    this.popups.clear()
    logger.info('[PopupManager] 清空所有弹窗')
  }
}

export const popupManager = new PopupManager()

export async function createPopupWindow(
  id: string,
  content: string,
  x: number,
  y: number,
  title = '通知',
  popupType = 'notification',
): Promise<BrowserWindow> {
  // 根据弹窗类型生成HTML
  const htmlContent =
    popupType === 'report'
      ? generateReportHtml(title, content)
      : generateNotificationHtml(title, content)

  const tempFile = await createTempHtmlFile(id, htmlContent)

  const window = new BrowserWindow({
    width: 800,
    height: 600,
    x,
    y,
    title,
    show: false,
    frame: true,
    resizable: true,
    skipTaskbar: false,
    autoHideMenuBar: true,
    transparent: false,
    backgroundColor: '#ffffff',
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../../../out/preload/index.js'),
      sandbox: false,
    },
  })

  window.on('closed', () => {
    popupManager.remove(id)
    cleanupTempFile(id)
  })

  const fileUrl = pathToFileURL(tempFile).href
  await window.loadURL(fileUrl)
  window.show()
  popupManager.register(id, window, 800, 600, x, y, title, content, popupType)

  logger.info(`[PopupManager] 创建弹窗: ${id}, type=${popupType}`)
  return window
}
