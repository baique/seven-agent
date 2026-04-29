import { useSocket } from '@renderer/composables/useSocket'
import { onUnmounted } from 'vue'

const domList: HTMLElement[] = []
const detectorList: Array<(e: MouseEvent) => boolean> = []

/**
 * 绑定 DOM 元素，鼠标在该 DOM 内时不忽略鼠标事件
 * @param dom DOM 元素
 */
export const bindToggleMouseEvent = (dom: HTMLElement) => {
  if (!dom) {
    console.error('用于设置切换窗口状态的 dom 为空')
    return
  }
  domList.push(dom)
}

/**
 * 绑定鼠标检测函数，检测函数返回 true 时不忽略鼠标事件
 * @param detector 检测函数，接收 MouseEvent 返回 boolean
 */
export const bindMouseEvent = (detector: (e: MouseEvent) => boolean) => {
  if (!detector) {
    console.error('检测函数为空')
    return
  }
  detectorList.push(detector)
}

/**
 * 初始化鼠标监听
 * 只要 DOM 检测或自定义检测器任意一个命中，就不忽略鼠标事件
 */
export const initWatchMouse = () => {
  const { setIgnoreMouse } = useSocket()
  const notifyEvent = wrapRequestAnimationFrame(async (e: MouseEvent) => {
    const isInDom = domList.find((d) => d && d.contains(e.target as Node))

    const isDetected = detectorList.find((detector) => detector(e))

    if (isInDom || isDetected) {
      await setIgnoreMouse(false, undefined, isInDom, isDetected)
    } else {
      await setIgnoreMouse(true, { forward: true })
    }
  })
  const validateMouseInDom = (e: MouseEvent) => notifyEvent(e)
  onUnmounted(() => {
    console.log('initWatchMouse unmounted')
    domList.length = 0
    detectorList.length = 0
    window.removeEventListener('mousemove', validateMouseInDom)
  })
  window.addEventListener('mousemove', validateMouseInDom)
}

export const wrapRequestAnimationFrame = (event: Function) => {
  let ticking = false
  return (...args: any[]) => {
    if (ticking) return
    requestAnimationFrame(() => {
      event(...args)
      ticking = false
    })
    ticking = true
  }
}

/** 面板锁定状态存储键名 */
const PANEL_LOCK_STORAGE_KEY = 'panel-lock-states'

/** 面板拖拽偏移存储键名前缀 */
const PANEL_DRAG_OFFSET_STORAGE_KEY = 'panel-drag-offset'

/** 面板类型 */
export type PanelType = 'personality' | 'terminal' | 'task' | 'history'

/** 面板锁定状态 */
export interface PanelLockStates {
  personality?: boolean
  terminal?: boolean
  task?: boolean
  history?: boolean
}

/**
 * 从localStorage加载面板锁定状态
 * @returns 面板锁定状态对象
 */
export const loadPanelLockStates = (): PanelLockStates => {
  try {
    const saved = localStorage.getItem(PANEL_LOCK_STORAGE_KEY)
    if (saved) {
      return JSON.parse(saved) as PanelLockStates
    }
  } catch (e) {
    console.error('[loadPanelLockStates] 解析失败:', e)
  }
  return {}
}

/**
 * 保存面板锁定状态到localStorage
 * @param type 面板类型
 * @param isLocked 是否锁定
 */
export const savePanelLockState = (type: PanelType, isLocked: boolean): void => {
  try {
    const states = loadPanelLockStates()
    states[type] = isLocked
    localStorage.setItem(PANEL_LOCK_STORAGE_KEY, JSON.stringify(states))
  } catch (e) {
    console.error('[savePanelLockState] 保存失败:', e)
  }
}

/**
 * 获取指定面板的锁定状态
 * @param type 面板类型
 * @returns 是否锁定，默认为false
 */
export const getPanelLockState = (type: PanelType): boolean => {
  const states = loadPanelLockStates()
  return states[type] ?? false
}

/**
 * 从localStorage加载指定面板的拖拽偏移
 * @param type 面板类型
 * @returns 拖拽偏移对象 { offsetX: number, offsetY: number }，无记录时返回 { offsetX: 0, offsetY: 0 }
 */
export const loadPanelDragOffset = (type: PanelType): { offsetX: number; offsetY: number } => {
  try {
    const key = `${PANEL_DRAG_OFFSET_STORAGE_KEY}-${type}`
    const saved = localStorage.getItem(key)
    if (saved) {
      const parsed = JSON.parse(saved) as { offsetX: number; offsetY: number }
      return {
        offsetX: typeof parsed.offsetX === 'number' ? parsed.offsetX : 0,
        offsetY: typeof parsed.offsetY === 'number' ? parsed.offsetY : 0,
      }
    }
  } catch (e) {
    console.error('[loadPanelDragOffset] 解析失败:', e)
  }
  return { offsetX: 0, offsetY: 0 }
}

/**
 * 保存面板的拖拽偏移到localStorage
 * @param type 面板类型
 * @param offsetX X轴偏移量(px)
 * @param offsetY Y轴偏移量(px)
 */
export const savePanelDragOffset = (type: PanelType, offsetX: number, offsetY: number): void => {
  try {
    const key = `${PANEL_DRAG_OFFSET_STORAGE_KEY}-${type}`
    localStorage.setItem(key, JSON.stringify({ offsetX, offsetY }))
  } catch (e) {
    console.error('[savePanelDragOffset] 保存失败:', e)
  }
}

/**
 * 获取指定面板的拖拽偏移X值
 * @param type 面板类型
 * @returns X轴偏移量(px)，无记录时返回0
 */
export const getPanelDragOffsetX = (type: PanelType): number => {
  return loadPanelDragOffset(type).offsetX
}

/**
 * 获取指定面板的拖拽偏移Y值
 * @param type 面板类型
 * @returns Y轴偏移量(px)，无记录时返回0
 */
export const getPanelDragOffsetY = (type: PanelType): number => {
  return loadPanelDragOffset(type).offsetY
}
