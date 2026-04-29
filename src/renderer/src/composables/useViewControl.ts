import { ref, type Ref } from 'vue'
import type { ModelViewState } from './useLive2DCore'

/** 本地存储键名 */
const STORAGE_KEY = 'live2d-view-state'
/** 最小缩放比例 */
const MIN_ZOOM = 0.5
/** 最大缩放比例 */
const MAX_ZOOM = 3
/** 缩放步进 */
const ZOOM_STEP = 0.1

/** 视图状态（持久化用） */
export interface ViewState {
  /** 缩放比例 */
  zoomScale: number
  /** 模型X坐标 */
  modelX: number
  /** 模型Y坐标 */
  modelY: number
}

/** 视角控制选项 */
export interface ViewControlOptions {
  /** 模型视图状态 */
  viewState: Ref<ModelViewState>
  /** 基础缩放比例 */
  baseScale: Ref<number>
  /** 更新视图状态方法 */
  updateViewState: (partial: Partial<ModelViewState>) => void
  /** 状态变化回调 */
  onChange?: (state: { x: number; y: number; scale: number }) => void
}

/**
 * 防抖函数
 * @param fn 目标函数
 * @param delay 延迟时间(ms)
 */
function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), delay)
  }) as T
}

/**
 * 视角控制组合式函数
 * 负责模型视角的缩放、拖拽、状态保存和恢复
 * @param options 视角控制选项
 * @returns 视角控制状态和方法
 */
export function useViewControl(options: ViewControlOptions) {
  /** 当前缩放比例 */
  const zoomScale = ref(1)
  /** 是否正在拖拽 */
  const isDragging = ref(false)
  /** 拖拽偏移量 */
  const dragOffset = ref({ x: 0, y: 0 })

  /** 保存视图状态到本地存储 */
  const saveViewState = () => {
    const vs = options.viewState.value
    const state: ViewState = {
      zoomScale: zoomScale.value,
      modelX: vs.x,
      modelY: vs.y,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }

  /**
   * 从本地存储加载视图状态
   * @returns 视图状态或null
   */
  const loadViewState = (): ViewState | null => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (!saved) return null
    try {
      return JSON.parse(saved) as ViewState
    } catch {
      return null
    }
  }

  /**
   * 应用视图状态
   * @param state 视图状态
   */
  const applyViewState = (state: ViewState) => {
    zoomScale.value = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, state.zoomScale))
    const newScale = options.baseScale.value * zoomScale.value
    options.updateViewState({
      scale: newScale,
      x: state.modelX,
      y: state.modelY,
    })
    options.onChange?.({ x: state.modelX, y: state.modelY, scale: zoomScale.value })
  }

  /** 重置视图到初始状态 */
  const resetView = () => {
    zoomScale.value = 1
    // x, y 是相对于屏幕中心的像素偏移量
    // (0, 0) 表示模型在屏幕正中央
    options.updateViewState({
      scale: options.baseScale.value,
      x: 0,
      y: 0,
    })
    localStorage.removeItem(STORAGE_KEY)
    const vs = options.viewState.value
    options.onChange?.({ x: vs.x, y: vs.y, scale: 1 })
  }

  /**
   * 处理滚轮缩放
   * @param e 滚轮事件
   * @param isMouseOnModel 鼠标是否在模型上
   * @returns 是否处理了事件
   */
  const handleWheel = (e: WheelEvent, isMouseOnModel: boolean) => {
    const vs = options.viewState.value

    // 如果鼠标不在模型上，不处理滚轮事件
    if (!isMouseOnModel) return false

    e.preventDefault()

    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP
    const newZoomScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoomScale.value + delta))
    if (newZoomScale === zoomScale.value) return true

    // 以鼠标位置为锚点计算缩放偏移
    // 鼠标位置相对于屏幕中心（与 emitPosition 保持一致）
    const mouseX = e.clientX - window.innerWidth / 2
    const mouseY = e.clientY - window.innerHeight / 2

    // 应用新的缩放比例
    const oldScale = vs.scale
    zoomScale.value = newZoomScale
    const newScale = options.baseScale.value * zoomScale.value

    // 计算缩放比例的变化（使用实际的 scale 值）
    const scaleRatio = newScale / oldScale

    // 调整模型位置，使鼠标位置保持不变
    // 新位置 = 鼠标位置 - (鼠标位置 - 旧位置) * 缩放比例变化
    // 这保持了鼠标指向的模型点在缩放后仍在鼠标位置
    options.updateViewState({
      scale: newScale,
      x: mouseX - (mouseX - vs.x) * scaleRatio,
      y: mouseY - (mouseY - vs.y) * scaleRatio,
    })

    saveViewState()
    const updatedVs = options.viewState.value
    options.onChange?.({ x: updatedVs.x, y: updatedVs.y, scale: zoomScale.value })
    return true
  }

  /**
   * 开始拖拽
   * @param e 鼠标事件
   * @param modelX 模型当前X坐标（相对于屏幕中心的偏移量）
   * @param modelY 模型当前Y坐标（相对于屏幕中心的偏移量）
   */
  const startDrag = (e: MouseEvent, modelX: number, modelY: number) => {
    isDragging.value = true

    // 将鼠标屏幕坐标转换为相对于屏幕中心的坐标（与 emitPosition 保持一致）
    const mouseX = e.clientX - window.innerWidth / 2
    const mouseY = e.clientY - window.innerHeight / 2
    dragOffset.value = { x: mouseX - modelX, y: mouseY - modelY }
  }

  /**
   * 处理拖拽移动
   * @param e 鼠标事件
   * @returns 是否处理了拖拽
   */
  const handleDragMove = (e: MouseEvent) => {
    if (!isDragging.value) return false

    // 将鼠标屏幕坐标转换为相对于屏幕中心的坐标（与 emitPosition 保持一致）
    const mouseX = e.clientX - window.innerWidth / 2
    const mouseY = e.clientY - window.innerHeight / 2
    const newX = mouseX - dragOffset.value.x
    const newY = mouseY - dragOffset.value.y
    options.updateViewState({ x: newX, y: newY })
    options.onChange?.({ x: newX, y: newY, scale: zoomScale.value })
    return true
  }

  /**
   * 结束拖拽
   * @returns 是否结束了拖拽
   */
  const endDrag = () => {
    if (!isDragging.value) return false
    isDragging.value = false
    saveViewState()
    const vs = options.viewState.value
    options.onChange?.({ x: vs.x, y: vs.y, scale: zoomScale.value })
    return true
  }

  /**
   * 处理窗口大小变化
   * 使用防抖避免频繁触发
   */
  const handleResize = debounce(() => {
    const vs = options.viewState.value
    const containerWidth = window.innerWidth
    const containerHeight = window.innerHeight

    // 只在模型超出边界时调整位置，不要强制居中
    let newX = vs.x
    let newY = vs.y

    // 确保模型不会完全移出屏幕
    const margin = 100 // 至少保留 100px 可见
    if (newX < -margin) newX = -margin
    if (newX > containerWidth + margin) newX = containerWidth + margin
    if (newY < -margin) newY = -margin
    if (newY > containerHeight + margin) newY = containerHeight + margin

    options.updateViewState({ x: newX, y: newY })
    options.onChange?.({ x: newX, y: newY, scale: zoomScale.value })
  }, 200)

  return {
    zoomScale,
    isDragging,
    MIN_ZOOM,
    MAX_ZOOM,
    saveViewState,
    loadViewState,
    applyViewState,
    resetView,
    handleWheel,
    startDrag,
    handleDragMove,
    endDrag,
    handleResize,
  }
}
