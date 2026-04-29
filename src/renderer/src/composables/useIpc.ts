import { eventBus, Events } from '../eventBus'

/**
 * IPC通信模块
 * 用于渲染进程与主进程之间的窗口管理通信
 * 替代原有的 Socket 窗口操作命令
 */

/**
 * 设置窗口置顶状态
 * @param alwaysOnTop - 是否置顶
 */
export async function setWindowTop(alwaysOnTop: boolean): Promise<void> {
  if (!window.api?.window?.setTop) {
    console.warn('[useIpc] window.setTop API 不可用')
    return
  }
  const result = await window.api.window.setTop(alwaysOnTop)
  if (result.success && result.alwaysOnTop !== undefined) {
    // 触发窗口状态变更事件
    eventBus.emit(Events.WINDOW_STATE_CHANGE, { alwaysOnTop: result.alwaysOnTop })
  }
}

/**
 * 切换窗口置顶状态
 */
export async function toggleWindowTop(): Promise<void> {
  if (!window.api?.window?.toggleTop) {
    console.warn('[useIpc] window.toggleTop API 不可用')
    return
  }
  const result = await window.api.window.toggleTop()
  if (result.success && result.alwaysOnTop !== undefined) {
    // 触发窗口状态变更事件
    eventBus.emit(Events.WINDOW_STATE_CHANGE, { alwaysOnTop: result.alwaysOnTop })
  }
}

/**
 * 获取窗口状态
 * @returns 窗口置顶状态
 */
export async function getWindowState(): Promise<{ alwaysOnTop: boolean }> {
  if (!window.api?.window?.getState) {
    console.warn('[useIpc] window.getState API 不可用')
    return { alwaysOnTop: false }
  }
  const result = await window.api.window.getState()
  if (result.success && result.alwaysOnTop !== undefined) {
    return { alwaysOnTop: result.alwaysOnTop }
  }
  return { alwaysOnTop: false }
}

/**
 * 设置鼠标穿透状态
 * @param state - 是否穿透
 * @param option - 可选配置
 */
export async function setIgnoreMouse(state: boolean, option?: any): Promise<void> {
  if (!window.api?.window?.setIgnoreMouse) {
    console.warn('[useIpc] window.setIgnoreMouse API 不可用')
    return
  }
  await window.api.window.setIgnoreMouse(state, option)
}

/**
 * 重置窗口位置
 */
export async function resetWindowPosition(): Promise<void> {
  if (!window.api?.window?.resetPosition) {
    console.warn('[useIpc] window.resetPosition API 不可用')
    return
  }
  await window.api.window.resetPosition()
}

/**
 * 重新打开弹窗
 * @param id - 弹窗ID
 * @param params - 弹窗参数
 */
export async function reopenPopup(
  id: string,
  params?: {
    title?: string
    content?: string
    width?: number
    height?: number
    x?: number
    y?: number
    popupType?: string
  },
): Promise<void> {
  if (!window.api?.popup?.reopen) {
    console.warn('[useIpc] popup.reopen API 不可用')
    return
  }
  await window.api.popup.reopen({ id, ...params })
}

/**
 * 创建新弹窗（由AI调用触发）
 * @param data - 弹窗数据
 */
export async function ipcCreatePopup(data: {
  id: string
  content: string
  title: string
  width: number
  height: number
  x: number
  y: number
  duration: number
  popupType: string
}): Promise<void> {
  if (!window.api?.popup?.create) {
    console.warn('[useIpc] popup.create API 不可用')
    return
  }
  const result = await window.api.popup.create(data)
  if (!result.success) {
    console.error('[useIpc] 创建弹窗失败:', result.error)
  }
}

/**
 * 最小化窗口
 */
export function minimizeWindow(): void {
  if (!window.api?.minimize) {
    console.warn('[useIpc] minimize API 不可用')
    return
  }
  window.api.minimize()
}

/**
 * 关闭窗口
 */
export function closeWindow(): void {
  if (!window.api?.close) {
    console.warn('[useIpc] close API 不可用')
    return
  }
  window.api.close()
}

/**
 * 创建审查窗口（由AI调用触发）
 * @param data - 审查数据
 */
export async function ipcCreateReview(data: {
  requestId: string
  toolName: string
  toolArgs: Record<string, unknown>
  riskDescription: string
  timeout: number
}): Promise<void> {
  if (!window.api?.review?.create) {
    console.warn('[useIpc] review.create API 不可用')
    return
  }
  const result = await window.api.review.create(data)
  if (!result.success) {
    console.error('[useIpc] 创建审查窗口失败:', result.error)
  }
}

/**
 * 获取Live2D模型配置
 * 直接从main进程获取，不再通过Server中转
 */
export async function getModelConfig(): Promise<{
  modelUrl: string
  idleBehaviorsPath: string | null
  defaultParamsPath: string | null
  defaultParams: Array<{ id: string; value: number }>
}> {
  if (!window.api?.model?.getConfig) {
    console.warn('[useIpc] model.getConfig API 不可用')
    throw new Error('model.getConfig API 不可用')
  }
  return window.api.model.getConfig()
}

/**
 * 使用IPC的组合式函数
 */
export function useIpc() {
  return {
    setWindowTop,
    toggleWindowTop,
    getWindowState,
    setIgnoreMouse,
    resetWindowPosition,
    reopenPopup,
    ipcCreatePopup,
    ipcCreateReview,
    minimizeWindow,
    closeWindow,
    getModelConfig,
  }
}
