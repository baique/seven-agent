<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import { useModelStateSync } from '../composables/useModelStateSync'
import { useLive2DCore } from '../composables/useLive2DCore'
import { useViewControl } from '../composables/useViewControl'
import { useGazeTracking } from '../composables/useGazeTracking'
import { useIdleBehaviors } from '../composables/useIdleBehaviors'
import { useModelInteraction } from '../composables/useModelInteraction'
import { useDebugAPI } from '../composables/useDebugAPI'
import { Easing } from '../state/paramAnimator'
import { wrapRequestAnimationFrame, bindMouseEvent } from '@renderer/util'

const props = defineProps<{
  modelUrl: string
  disabled?: boolean
  defaultParams?: { id: string; value: number }[]
  idleBehaviorsPath?: string | null
  hideLoading?: boolean
}>()

const emit = defineEmits<{
  loaded: []
  positionChange: [position: { x: number; y: number; width: number; height: number }]
  modelHover: [isHovering: boolean]
  idleBehavior: [behaviorId: string | null]
  resetPanels: []
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let modelStateSync: ReturnType<typeof useModelStateSync> | null = null

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

const {
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
} = useLive2DCore()

const viewControl = useViewControl({
  viewState,
  baseScale,
  updateViewState,
  onChange: (state) => {
    emitPosition()
    modelStateSync?.updateTransform(state)
  },
})

const gazeEnabled = computed(() => !viewControl.isDragging.value)
const gazeTracking = useGazeTracking({
  model,
  enabled: gazeEnabled,
})

const idleBehaviors = useIdleBehaviors({
  model,
  animator,
  enabled: computed(() => !loading.value),
  prefersReducedMotion,
  idleBehaviorsPath: props.idleBehaviorsPath,
  onBehaviorStart: (id) => emit('idleBehavior', id),
  onBehaviorEnd: () => emit('idleBehavior', null),
  setBeforeUpdateCallback,
})

const modelInteraction = useModelInteraction({
  model,
  viewState,
  onHoverChange: (isHovering) => emit('modelHover', isHovering),
})

const { setupDebugAPI, cleanupDebugAPI } = useDebugAPI({ model, animator })

const initModelStateSync = (sendModelState: (command: string, data: any) => void) => {
  modelStateSync = useModelStateSync(sendModelState)
}

const emitPosition = () => {
  const vs = viewState.value
  const m = model.value

  // 计算人物中心点的屏幕坐标
  // vs.x, vs.y 是相对于屏幕中心的偏移量
  const screenCenterX = window.innerWidth / 2
  const screenCenterY = window.innerHeight / 2
  const modelCenterX = screenCenterX + vs.x
  const modelCenterY = screenCenterY + vs.y

  // 计算模型的真实宽高（屏幕像素尺寸）
  // 官方公式：投影矩阵使用 scale(1, width/height)
  // 模型在屏幕上的高度 = 窗口高度 * 用户缩放 * 模型矩阵Y缩放
  let modelWidth = 0
  let modelHeight = 0
  if (m) {
    modelHeight = vs.height * vs.scale * m.modelMatrixScaleY
    modelWidth = modelHeight * (m.modelWidth / m.modelHeight)
  }

  if (modelCenterX === 0) return
  console.log({
    x: modelCenterX,
    y: modelCenterY,
    width: modelWidth,
    height: modelHeight,
    vsScale: vs.scale,
    vsHeight: vs.height,
    vsWidth: vs.width,
    modelMatrixScaleY: m?.modelMatrixScaleY,
    modelMatrixScaleX: m?.modelMatrixScaleX,
    modelHeight_normalized: m?.modelHeight,
    modelWidth_normalized: m?.modelWidth,
  })

  emit('positionChange', {
    x: modelCenterX,
    y: modelCenterY,
    width: modelWidth,
    height: modelHeight,
  })
}

const setParameter = (paramId: string, value: number | string) => {
  const m = model.value
  if (!m) return
  m.setExternalParameter(paramId, Number(value))
}

/**
 * 清除外部参数覆盖，恢复由 SDK 管线控制
 * @param paramId 参数字符串ID
 */
const clearParameter = (paramId: string) => {
  const m = model.value
  if (!m) return
  m.clearExternalParameter(paramId)
}

const animateParams = (
  params: Array<{ name: string; value: number; defValue?: number }>,
  transitionMs?: number,
) => {
  const anim = animator.value
  if (!anim) return
  const animParams = params.map((p) => ({ name: p.name, value: p.value }))
  anim.animateMultiple(animParams, { duration: transitionMs ?? 300, easing: Easing.easeOut })
}

/**
 * 动画到目标值后清除外部参数覆盖
 * 用于表情/动作结束时平滑过渡回 SDK 管线控制
 */
const animateAndClearParams = (
  params: Array<{ name: string; value: number; defValue?: number }>,
  transitionMs?: number,
) => {
  const anim = animator.value
  const m = model.value
  if (!anim || !m) return
  const animParams = params.map((p) => ({ name: p.name, value: p.defValue ?? 0 }))
  anim
    .animateMultiple(animParams, { duration: transitionMs ?? 300, easing: Easing.easeOut })
    .then(() => {
      for (const p of params) {
        m.clearExternalParameter(p.name)
      }
    })
}

const setMouthOpenness = (openness: number) => {
  const m = model.value
  if (!m) return
  m.setExternalParameter('ParamMouthOpenY', openness)
}

const resetView = () => {
  viewControl.resetView()
  const vs = viewState.value
  modelStateSync?.setTransform({ scale: 1, x: vs.x, y: vs.y })
}

const restoreContinuousActions = (actions: { paramId: string; value: number | string }[]) => {
  if (!model.value) return
  for (const action of actions) {
    setParameter(action.paramId, action.value)
  }
}

const hitTest = (x: number, y: number): boolean => {
  if (props.disabled) return false
  return modelInteraction.hitTest(x, y)
}

const handleMouseEnter = () => {
  modelInteraction.setHover(true)
  emit('modelHover', true)
  emitPosition()
}

const handleMouseLeave = () => {
  modelInteraction.setHover(false)
  emit('modelHover', false)
  emitPosition()
}

let moveLogCounter = 0
const handleMouseMove = wrapRequestAnimationFrame((e: MouseEvent) => {
  if (props.disabled) return

  viewControl.handleDragMove(e)

  const m = model.value
  if (!m) return

  modelInteraction.checkHover(e.clientX, e.clientY)
  if (viewControl.isDragging.value) return

  const vs = viewState.value
  gazeTracking.updateTarget(e.clientX, e.clientY, vs.x, vs.y)
})

let lastClickTime = 0
const DOUBLE_CLICK_DELAY = 300

const handleMouseDown = (e: MouseEvent) => {
  console.log('[Mouse] mousedown', { x: e.clientX, y: e.clientY, target: e.target?.tagName })
  if (props.disabled) return
  const m = model.value
  if (!m) {
    console.log('[Mouse] 模型未加载')
    return
  }
  const hit = modelInteraction.hitTest(e.clientX, e.clientY)
  console.log('[Mouse] hitTest结果', hit)
  if (!hit) return

  const currentTime = Date.now()
  if (currentTime - lastClickTime < DOUBLE_CLICK_DELAY) {
    emit('resetPanels')
  }
  lastClickTime = currentTime

  const vs = viewState.value
  viewControl.startDrag(e, vs.x, vs.y)
  e.preventDefault()
}

const handleMouseUp = () => {
  if (props.disabled) return
  viewControl.endDrag()
}

const handleWheel = (e: WheelEvent) => {
  if (props.disabled) return
  // 实时检测鼠标是否在模型上
  const isMouseOnModel = modelInteraction.checkHover(e.clientX, e.clientY)
  viewControl.handleWheel(e, isMouseOnModel)
}

const handleResize = () => {
  // 暂时不更新画布尺寸，只更新视图状态
  viewControl.handleResize()
}

const initLive2D = async () => {
  if (!canvasRef.value) return

  const success = await init({
    canvas: canvasRef.value,
    modelUrl: props.modelUrl,
    defaultParams: props.defaultParams,
    onLoaded: () => {
      emit('loaded')
      emitPosition()
    },
    onError: (err) => console.error('Failed to init Live2D:', err),
  })

  if (success) {
    const savedState = viewControl.loadViewState()
    if (savedState) {
      viewControl.applyViewState(savedState)
    }
    setupDebugAPI()
    idleBehaviors.startIdleBehaviors()
  }
}

onMounted(() => {
  initLive2D()
  bindMouseEvent((e) => hitTest(e.clientX, e.clientY))
  window.addEventListener('resize', handleResize)
  window.addEventListener('mousemove', handleMouseMove)
  window.addEventListener('mousedown', handleMouseDown)
  window.addEventListener('mouseup', handleMouseUp)
  window.addEventListener('wheel', handleWheel, { passive: false })
})

onUnmounted(() => {
  idleBehaviors.stopIdleBehaviors()
  gazeTracking.stopTracking()
  cleanupDebugAPI()

  window.removeEventListener('resize', handleResize)
  window.removeEventListener('mousemove', handleMouseMove)
  window.removeEventListener('mousedown', handleMouseDown)
  window.removeEventListener('mouseup', handleMouseUp)
  window.removeEventListener('wheel', handleWheel)

  destroy()
})

watch(
  () => props.modelUrl,
  () => {
    if (!canvasRef.value) return
    reload({
      canvas: canvasRef.value,
      modelUrl: props.modelUrl,
      defaultParams: props.defaultParams,
      onLoaded: () => {
        emit('loaded')
        emitPosition()
        idleBehaviors.startIdleBehaviors()
        setupDebugAPI()
      },
      onError: (err) => console.error('Failed to reload Live2D:', err),
    })
  },
)

defineExpose({
  setParameter,
  clearParameter,
  animateParams,
  animateAndClearParams,
  setMouthOpenness,
  resetView,
  initModelStateSync,
  restoreContinuousActions,
  hitTest,
  loading,
})
</script>

<template>
  <div class="live2d-wrapper" :class="{ loading: loading }">
    <canvas
      ref="canvasRef"
      :class="['live2d-canvas', { hover: modelInteraction.isMouseOnModel.value }]"
      @mouseenter="handleMouseEnter"
      @mouseleave="handleMouseLeave"
    />
    <div v-if="loading && !hideLoading" class="live2d-loading">
      <div class="live2d-loading-spinner"></div>
      <span>加载模型中...</span>
    </div>
    <div v-if="error" class="live2d-error">
      {{ error }}
    </div>
  </div>
</template>

<style scoped>
.live2d-wrapper {
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.001);
  display: flex;
  justify-content: center;
  align-items: center;
  pointer-events: none;
}

.live2d-wrapper.loading {
  pointer-events: none;
}

.live2d-wrapper.loading .live2d-canvas {
  pointer-events: none;
}

.live2d-canvas {
  width: 100%;
  height: 100%;
  background-color: transparent;
  isolation: isolate;
}

.live2d-loading {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--text-secondary, #4a4a68);
  font-size: 14px;
  pointer-events: none;
  z-index: -1;
}

.live2d-loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(0, 102, 255, 0.2);
  border-top-color: #0066ff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.live2d-error {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: #ff4d4f;
  font-size: 14px;
  text-align: center;
  padding: 0 20px;
}
</style>
