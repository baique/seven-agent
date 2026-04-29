import { ref, onUnmounted } from 'vue'
import { eventBus, Events } from '../eventBus'
import { getStateById, type StateParam } from '../state/characterStates'

interface ActiveState {
  id: string
  params: StateParam[]
  startIntensity: number
  startTime: number
  duration: number
  frameId: number | null
}

const DECAY_BASE_TIME = 10000

function easeIn(t: number): number {
  return t * t
}

function getDecayDuration(_intensity: number): number {
  return DECAY_BASE_TIME
}

/**
 * 情绪衰减组合式函数
 * 情绪激活后自动衰减，衰减完成后清除外部参数覆盖
 * @param setParameter 设置参数回调（使用 setExternalParameter）
 * @param clearParameter 清除参数回调（使用 clearExternalParameter）
 */
export function useEmotionDecay(
  setParameter: (paramId: string, value: number | string) => void,
  clearParameter: (paramId: string) => void = () => {},
) {
  const activeStates = ref<Map<string, ActiveState>>(new Map())

  const applyParams = (params: StateParam[], intensity: number) => {
    for (const p of params) setParameter(p.name, p.value * intensity)
  }

  const clearParams = (params: StateParam[]) => {
    for (const p of params) clearParameter(p.name)
  }

  const decayState = (stateId: string) => {
    const state = activeStates.value.get(stateId)
    if (!state) return

    const elapsed = Date.now() - state.startTime
    const progress = Math.min(elapsed / state.duration, 1)
    const easedProgress = easeIn(progress)
    const currentIntensity = state.startIntensity * (1 - easedProgress)

    if (progress >= 1) {
      // 衰减完成，先设为默认值再清除外部参数覆盖
      for (const p of state.params) setParameter(p.name, p.defValue)
      clearParams(state.params)
      activeStates.value.delete(stateId)
    } else {
      applyParams(state.params, currentIntensity)
      state.frameId = requestAnimationFrame(() => decayState(stateId))
    }
  }

  const startDecay = (stateId: string, params: StateParam[], intensity: number) => {
    const existing = activeStates.value.get(stateId)
    if (existing) {
      if (existing.frameId) cancelAnimationFrame(existing.frameId)
    }

    const state: ActiveState = {
      id: stateId,
      params,
      startIntensity: intensity,
      startTime: Date.now(),
      duration: getDecayDuration(intensity),
      frameId: null,
    }
    activeStates.value.set(stateId, state)
    state.frameId = requestAnimationFrame(() => decayState(stateId))
  }

  const onStateStart = (cmd: { id: string; params: StateParam[]; intensity?: number }) => {
    const stateDef = getStateById(cmd.id)
    if (!stateDef) return
    const intensity = Math.max(0, Math.min(1, cmd.intensity ?? 1))
    applyParams(stateDef.active, intensity)
    startDecay(cmd.id, stateDef.active, intensity)
  }

  const unsubEmotion = eventBus.on(Events.EMOTION_START, onStateStart)

  onUnmounted(() => {
    unsubEmotion()
    for (const s of activeStates.value.values()) {
      s.frameId && cancelAnimationFrame(s.frameId)
      clearParams(s.params)
    }
  })

  return { activeStates }
}
