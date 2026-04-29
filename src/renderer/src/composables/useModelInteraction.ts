import { ref, type Ref } from 'vue'
import type { CubismModelWrapper } from '../live2d/CubismModelWrapper'
import type { ModelViewState } from './useLive2DCore'
import { HIT_AREA_WIDTH_RATIO, HIT_AREA_HEIGHT_RATIO } from '../live2d'

/** 模型交互选项 */
export interface ModelInteractionOptions {
  /** 模型引用 */
  model: Ref<CubismModelWrapper | null>
  /** 模型视图状态引用 */
  viewState: Ref<ModelViewState>
  /** 悬停状态变化回调 */
  onHoverChange?: (isHovering: boolean) => void
}

/**
 * 模型交互组合式函数
 * 负责处理鼠标与模型的交互，包括悬停检测和碰撞检测
 * @param options 模型交互选项
 * @returns 模型交互状态和方法
 */
export function useModelInteraction(options: ModelInteractionOptions) {
  /** 鼠标是否在模型上 */
  const isMouseOnModel = ref(false)
  /** 上次悬停状态 */
  const lastHoverState = ref(false)

  /**
   * 碰撞检测
   * @param x 屏幕X坐标（相对于屏幕左上角）
   * @param y 屏幕Y坐标（相对于屏幕左上角）
   * @returns 是否命中模型
   */
  const hitTest = (x: number, y: number): boolean => {
    const m = options.model.value
    const vs = options.viewState.value
    if (!m || !vs.width || !vs.height) return false

    // 计算模型的屏幕坐标和宽高
    // vs.x, vs.y 是相对于屏幕中心的偏移量（与 emitPosition 保持一致）
    const screenCenterX = window.innerWidth / 2
    const screenCenterY = window.innerHeight / 2
    const modelCenterX = screenCenterX + vs.x
    const modelCenterY = screenCenterY + vs.y

    // 模型实际渲染尺寸 = 窗口高度 * 用户缩放 * 模型矩阵Y缩放
    const actualModelHeight = vs.height * vs.scale * m.modelMatrixScaleY
    const actualModelWidth = actualModelHeight * (m.modelWidth / m.modelHeight)

    // 碰撞检测区域（基于实际模型尺寸的比例）
    const modelWidth = actualModelWidth * HIT_AREA_WIDTH_RATIO
    const modelHeight = actualModelHeight * HIT_AREA_HEIGHT_RATIO

    // 计算模型的边界框（考虑边距）
    const margin = 0.2 // 20% 边距
    const left = modelCenterX - (modelWidth / 2) * (1 + margin)
    const right = modelCenterX + (modelWidth / 2) * (1 + margin)
    const top = modelCenterY - (modelHeight / 2) * (1 + margin)
    const bottom = modelCenterY + (modelHeight / 2) * (1 + margin)

    // 检查点是否在边界框内
    return x >= left && x <= right && y >= top && y <= bottom
  }

  /**
   * 检查并更新悬停状态
   * @param clientX 鼠标X坐标
   * @param clientY 鼠标Y坐标
   * @returns 当前是否悬停
   */
  const checkHover = (clientX: number, clientY: number): boolean => {
    const isHovering = hitTest(clientX, clientY)
    isMouseOnModel.value = isHovering
    if (isHovering !== lastHoverState.value) {
      lastHoverState.value = isHovering
      options.onHoverChange?.(isHovering)
    }
    return isHovering
  }

  /**
   * 设置悬停状态
   * @param value 是否悬停
   */
  const setHover = (value: boolean) => {
    isMouseOnModel.value = value
    if (value !== lastHoverState.value) {
      lastHoverState.value = value
      options.onHoverChange?.(value)
    }
  }

  return {
    isMouseOnModel,
    lastHoverState,
    hitTest,
    checkHover,
    setHover,
  }
}
