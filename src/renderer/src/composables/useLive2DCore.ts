import { ref, shallowRef } from 'vue'
import { CubismModelWrapper } from '../live2d/CubismModelWrapper'
import { ensureCubismFrameworkInitialized } from '../live2d/CubismFrameworkInit'
import { CubismMatrix44 } from '@cubism/math/cubismmatrix44'
import { ParamAnimator } from '../state/paramAnimator'
import type { ParamAnimator as IParamAnimator } from '../state/paramAnimator'

/** Live2D模型类型导出 */
export type Live2DModelType = CubismModelWrapper

/** 模型参数配置 */
export interface ModelParam {
  id: string
  value: number
}

/** 初始化选项 */
export interface InitOptions {
  /** canvas元素 */
  canvas: HTMLCanvasElement
  /** 模型URL */
  modelUrl: string
  /** 默认参数数组 */
  defaultParams?: ModelParam[]
  /** 加载完成回调 */
  onLoaded?: () => void
  /** 错误回调 */
  onError?: (err: string) => void
}

/** 模型视图状态（替代PIXI的transform） */
export interface ModelViewState {
  /** 模型X坐标（CSS像素，相对屏幕中心） */
  x: number
  /** 模型Y坐标（CSS像素，相对屏幕中心） */
  y: number
  /** 模型缩放 */
  scale: number
  /** 模型宽度（像素） */
  width: number
  /** 模型高度（像素） */
  height: number
}

/**
 * 检测是否为虚拟机或低性能环境
 */
const isVirtualMachine = (): boolean => {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    if (!gl) return true
    const debugInfo = (gl as WebGLRenderingContext).getExtension('WEBGL_debug_renderer_info')
    if (!debugInfo) return false
    const renderer = (gl as WebGLRenderingContext).getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
    const vmKeywords = [
      'VirtualBox',
      'VMware',
      'Parallels',
      'QEMU',
      'Virtual Machine',
      'Basic Render',
      'Microsoft Basic',
      'GDI',
    ]
    return vmKeywords.some((keyword) => renderer.toLowerCase().includes(keyword.toLowerCase()))
  } catch {
    return false
  }
}

/**
 * 设置模型默认状态
 * 使用 setExternalParameter 确保参数不被 loadParameters 覆盖
 */
async function setupModelDefaultState(
  model: CubismModelWrapper,
  defaultParams?: ModelParam[],
): Promise<void> {
  if (!model.getModel()) return

  // 通过外部参数系统设置默认参数（不会被 loadParameters 覆盖）
  if (defaultParams && defaultParams.length > 0) {
    for (const param of defaultParams) {
      try {
        model.setExternalParameter(param.id, param.value)
        // console.log(`[Live2DCore] 设置默认参数: ${param.id} = ${param.value}`)
      } catch (e) {
        // console.warn(`[Live2DCore] 设置参数失败: ${param.id}`, e)
      }
    }
  }

  // 设置默认表情
  const expressionNames = model.getExpressionNames()
  if (expressionNames.length > 0) {
    const defaultExpr = expressionNames.includes('Idle') ? 'Idle' : expressionNames[0]
    try {
      model.setExpression(defaultExpr)
      // console.log(`[Live2DCore] 设置默认表情: ${defaultExpr}`)
    } catch (e) {
      // console.warn(`[Live2DCore] 设置表情失败: ${defaultExpr}`, e)
    }
  }

  // 播放初始 Idle 动画
  const motionGroups = model.getMotionGroupNames()
  if (motionGroups.includes('Idle')) {
    await playIdleMotionWhenReady(model)
  }
}

/**
 * 等待 Idle 动作加载完成后播放
 */
async function playIdleMotionWhenReady(
  model: CubismModelWrapper,
  maxWaitMs: number = 5000,
): Promise<void> {
  const checkInterval = 100
  const startTime = Date.now()

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const result = model.startMotion('Idle', 0, 1)
      if (result !== -1) {
        // console.log('[Live2DCore] 播放Idle动画成功')
        return
      }
    } catch (e) {
      // console.warn('[Live2DCore] 播放Idle动画失败，重试中...', e)
    }

    await new Promise((resolve) => setTimeout(resolve, checkInterval))
  }

  // console.warn('[Live2DCore] 等待Idle动画加载超时')
}

/**
 * Live2D核心功能组合式函数
 * 负责WebGL上下文创建、Live2D模型加载和渲染管理
 * 使用官方Cubism SDK替代pixi-live2d-display
 */
export function useLive2DCore() {
  /** WebGL渲染上下文 */
  const gl = shallowRef<WebGLRenderingContext | WebGL2RenderingContext | null>(null)
  /** Live2D模型实例 */
  const model = shallowRef<CubismModelWrapper | null>(null)
  /** 参数动画器 */
  const animator = shallowRef<IParamAnimator | null>(null)
  /** 基础缩放比例（默认 0.5，即占满全屏的 50%） */
  const baseScale = ref(0.5)
  /** 加载状态 */
  const loading = ref(true)
  /** 错误信息 */
  const error = ref<string | null>(null)
  /** 模型视图状态 */
  const viewState = ref<ModelViewState>({
    x: 0,
    y: 0,
    scale: 1,
    width: 0,
    height: 0,
  })
  /** 投影矩阵 */
  let projection: CubismMatrix44 | null = null
  /** 渲染循环RAF ID */
  let renderLoopId: number | null = null
  /** 是否正在初始化 */
  let isInitializing = false
  /** 渲染前回调（在 m.update() 之前执行） */
  let beforeUpdateCallback: (() => void) | null = null

  /**
   * 渲染循环
   * 投影矩阵构建顺序：宽高比校正 → 用户位移 → 用户缩放 → 模型矩阵(draw中)
   * 变换顺序：模型矩阵 → 用户缩放 → 用户位移 → 宽高比校正
   * 用户位移在屏幕空间中，不受缩放影响，确保拖拽1:1跟随鼠标
   */
  const renderLoop = () => {
    const m = model.value
    const glCtx = gl.value
    if (!m || !glCtx || !m.isLoaded) {
      renderLoopId = requestAnimationFrame(renderLoop)
      return
    }

    if (!projection) {
      // console.warn('[Live2DCore] renderLoop: projection is null, skipping frame')
      renderLoopId = requestAnimationFrame(renderLoop)
      return
    }

    const canvas = glCtx.canvas as HTMLCanvasElement
    glCtx.viewport(0, 0, canvas.width, canvas.height)
    glCtx.clearColor(0, 0, 0, 0)
    glCtx.clear(glCtx.COLOR_BUFFER_BIT)

    // 执行渲染前回调（用于设置参数，在物理系统之前）
    beforeUpdateCallback?.()

    m.update()

    if (!projection) {
      projection = new CubismMatrix44()
    }

    const canvasWidth = canvas.width
    const canvasHeight = canvas.height
    // 使用CSS像素尺寸计算NDC（vs.x/y是CSS像素，来自鼠标事件）
    const cssWidth = canvas.clientWidth || window.innerWidth
    const cssHeight = canvas.clientHeight || window.innerHeight

    projection.loadIdentity()

    // 1. 宽高比校正（使用物理像素比例，确保渲染不变形）
    const aspectRatio = canvasWidth / canvasHeight
    projection.scale(1, aspectRatio)

    // 2. 用户位移（CSS像素 → NDC，在屏幕空间中移动，不受缩放影响）
    // Y 方向需要除以宽高比，确保位移和模型坐标受到相同的缩放影响
    const vs = viewState.value
    const ndcX = (vs.x / cssWidth) * 2
    const ndcY = (-(vs.y / cssHeight) * 2) / aspectRatio
    projection.translateRelative(ndcX, ndcY)

    // 3. 用户缩放（围绕模型中心缩放）
    projection.scaleRelative(vs.scale, vs.scale)

    // 4. 模型矩阵在 draw() 中应用（来自模型布局的 _modelMatrix）
    // DEBUG: 渲染流程调试日志已禁用
    // console.log('[DEBUG renderLoop] Before m.draw(), projection:', projection?.getArray()?.slice(0, 4))
    m.draw(projection)
    // console.log('[DEBUG renderLoop] After m.draw()')

    renderLoopId = requestAnimationFrame(renderLoop)
  }

  /**
   * 初始化Live2D
   */
  const init = async (options: InitOptions) => {
    if (isInitializing) return false
    isInitializing = true
    loading.value = true
    error.value = null

    try {
      await new Promise((resolve) => setTimeout(resolve, 100))

      ensureCubismFrameworkInitialized()

      const containerWidth = window.innerWidth
      const containerHeight = window.innerHeight
      const isLowPerf = isVirtualMachine()

      const canvas = options.canvas
      canvas.width = containerWidth * (isLowPerf ? 1 : Math.min(window.devicePixelRatio || 1, 2))
      canvas.height = containerHeight * (isLowPerf ? 1 : Math.min(window.devicePixelRatio || 1, 2))
      canvas.style.width = containerWidth + 'px'
      canvas.style.height = containerHeight + 'px'

      const glContext =
        canvas.getContext('webgl2', {
          alpha: true,
          premultipliedAlpha: true,
          antialias: !isLowPerf,
          powerPreference: 'high-performance',
        }) ||
        canvas.getContext('webgl', {
          alpha: true,
          premultipliedAlpha: true,
          antialias: !isLowPerf,
          powerPreference: 'high-performance',
        })

      if (!glContext) {
        throw new Error('Failed to create WebGL context')
      }
      gl.value = glContext

      glContext.enable(glContext.BLEND)
      glContext.blendFunc(glContext.ONE, glContext.ONE_MINUS_SRC_ALPHA)

      const modelWrapper = new CubismModelWrapper()

      await modelWrapper.loadFromUrl(options.modelUrl, glContext, canvas.width, canvas.height)

      // 模型加载完成后，立即设置 viewState
      // 默认占满全屏的 50%（取宽高比例的最小值）
      const mw = modelWrapper.canvasWidth
      const mh = modelWrapper.canvasHeight
      if (mw > 0 && mh > 0) {
        const scaleX = containerWidth / mw
        const scaleY = containerHeight / mh
        baseScale.value = Math.min(scaleX, scaleY) * 0.5
      }
      viewState.value = {
        x: 0,
        y: 0,
        scale: baseScale.value,
        width: containerWidth,
        height: containerHeight,
      }
      // console.log('[Live2DCore] viewState 初始化完成', viewState.value)

      model.value = modelWrapper

      // 使用回调函数创建 ParamAnimator，通过 setExternalParameter 设置参数
      animator.value = new ParamAnimator(
        (name: string, value: number) => modelWrapper.setExternalParameter(name, value),
        (name: string) => modelWrapper.getParameterValueByStringId(name),
      )

      await setupModelDefaultState(modelWrapper, options.defaultParams)

      projection = new CubismMatrix44()

      renderLoopId = requestAnimationFrame(renderLoop)

      loading.value = false
      isInitializing = false
      options.onLoaded?.()
      return true
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      error.value = '初始化失败: ' + errMsg
      loading.value = false
      isInitializing = false
      options.onError?.(errMsg)
      return false
    }
  }

  /** 销毁所有资源 */
  const destroy = () => {
    if (renderLoopId !== null) {
      cancelAnimationFrame(renderLoopId)
      renderLoopId = null
    }
    if (animator.value) {
      animator.value.destroy()
      animator.value = null
    }
    if (model.value) {
      model.value.release()
      model.value = null
    }
    if (gl.value) {
      const loseCtx = gl.value.getExtension('WEBGL_lose_context')
      if (loseCtx) loseCtx.loseContext()
      gl.value = null
    }
    projection = null
  }

  /**
   * 重新加载模型
   */
  const reload = async (options: InitOptions) => {
    destroy()
    return init(options)
  }

  /**
   * 更新视图状态
   * @param partial 部分视图状态
   */
  const updateViewState = (partial: Partial<ModelViewState>) => {
    viewState.value = { ...viewState.value, ...partial }
  }

  /**
   * 设置渲染前回调
   * @param callback 回调函数，在 m.update() 之前执行
   */
  const setBeforeUpdateCallback = (callback: (() => void) | null) => {
    beforeUpdateCallback = callback
  }

  return {
    gl,
    model,
    animator,
    baseScale,
    loading,
    error,
    viewState,
    init,
    destroy,
    reload,
    updateViewState,
    setBeforeUpdateCallback,
  }
}
