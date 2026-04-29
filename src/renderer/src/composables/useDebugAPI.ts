import type { Ref } from 'vue'
import type { CubismModelWrapper } from '../live2d/CubismModelWrapper'
import type { ParamAnimator } from '../state/paramAnimator'
import { CHARACTER_STATES, getStateById } from '../state/characterStates'
import { Easing } from '../state/paramAnimator'

/** 调试API选项 */
export interface DebugAPIOptions {
  /** 模型引用 */
  model: Ref<CubismModelWrapper | null>
  /** 动画器引用 */
  animator: { value: ParamAnimator | null }
}

/** Live2D调试API接口 */
export interface Live2DDebugAPI {
  /** 当前模型实例 */
  model: CubismModelWrapper | null
  /**
   * 设置参数值
   * @param paramId 参数ID
   * @param value 参数值
   */
  setParam: (paramId: string, value: number) => void
  /**
   * 获取参数值
   * @param paramId 参数ID
   * @returns 参数值
   */
  getParam: (paramId: string) => number
  /**
   * 重置参数到默认值
   * @param paramId 参数ID
   */
  resetParam: (paramId: string) => void
  /**
   * 播放动作
   * @param group 动作组
   * @param index 动作索引
   */
  playMotion: (group: string, index?: number) => Promise<void>
  /** 停止所有动作 */
  stopMotion: () => void
  /**
   * 播放表情
   * @param name 表情名称
   */
  playExpression: (name: string) => Promise<void>
  /** 重置表情 */
  resetExpression: () => void
  /**
   * 播放状态
   * @param stateId 状态ID
   * @param duration 持续时间
   * @param intensity 强度
   * @param transitionMs 过渡时间
   */
  playState: (stateId: string, duration?: number, intensity?: number, transitionMs?: number) => void
  /**
   * 列出所有状态
   * @returns 表情和动作列表
   */
  listStates: () => { faces: string[]; actions: string[] }
  /** 所有状态定义 */
  states: typeof CHARACTER_STATES
}

/**
 * 调试API组合式函数
 * 负责设置全局调试API，方便开发调试
 * @param options 调试API选项
 * @returns 调试API操作方法
 */
export function useDebugAPI(options: DebugAPIOptions) {
  /**
   * 设置调试API
   * 将API挂载到 window.live2dDebug
   */
  const setupDebugAPI = () => {
    const debugAPI: Live2DDebugAPI = {
      get model() {
        return options.model.value
      },
      setParam: (paramId: string, value: number) => {
        const m = options.model.value
        if (!m) return
        m.setExternalParameter(paramId, value)
      },
      getParam: (paramId: string): number => {
        const m = options.model.value
        if (!m) return 0
        return m.getParameterValueByStringId(paramId)
      },
      resetParam: (paramId: string) => {
        const m = options.model.value
        if (!m) return
        m.clearExternalParameter(paramId)
      },
      playMotion: async (group: string, index: number = 0) => {
        const m = options.model.value
        if (!m) {
          console.warn('[Live2D] 模型未加载')
          return
        }
        try {
          m.startMotion(group, index, 2) // PriorityNormal=2
          console.log('[Live2D] 播放动作:', group, index)
        } catch (e) {
          console.error('[Live2D] 播放动作失败:', e)
        }
      },
      stopMotion: () => {
        const m = options.model.value
        if (!m) return
        m.stopAllMotions()
        console.log('[Live2D] 停止所有动作')
      },
      playExpression: async (name: string) => {
        const m = options.model.value
        if (!m) {
          console.warn('[Live2D] 模型未加载')
          return
        }
        try {
          m.setExpression(name)
          console.log('[Live2D] 播放表情:', name)
        } catch (e) {
          console.error('[Live2D] 播放表情失败:', e)
        }
      },
      resetExpression: () => {
        // 新SDK无直接重置表情方法，此操作为no-op
        console.log('[Live2D] 重置表情（当前SDK不支持直接重置）')
      },
      playState: (
        stateId: string,
        duration?: number,
        intensity?: number,
        transitionMs?: number,
      ) => {
        const m = options.model.value
        const animator = options.animator.value
        if (!m || !animator) {
          console.warn('[Live2D] 模型未加载')
          return
        }
        const stateDef = getStateById(stateId)
        if (!stateDef) {
          const available = Object.keys(CHARACTER_STATES)
          console.warn('[Live2D] 未知的状态ID:', stateId, '可用:', available)
          return
        }
        const clampedIntensity = Math.max(0, Math.min(100, intensity ?? 100)) / 100
        const animDuration = transitionMs ?? 300
        const params = stateDef.active.map((p) => ({
          name: p.name,
          value: p.value * clampedIntensity,
        }))
        animator.animateMultiple(params, { duration: animDuration, easing: Easing.easeOut })
        const typeStr = stateDef.type === 1 ? '表情' : stateDef.type === 2 ? '动作' : '情绪'

        if (!duration && stateDef.type === 1) {
          duration = 2
        }

        const actualDuration = duration ?? 0

        console.log(
          `[Live2D] 播放${typeStr}: ${stateId} (强度${clampedIntensity}, 持续${actualDuration}秒)`,
        )
        if (actualDuration > 0) {
          setTimeout(() => {
            if (!options.animator.value) return
            const resetParams = stateDef.default.map((p) => ({
              name: p.name,
              value: p.defValue,
            }))
            options.animator.value.animateMultiple(resetParams, {
              duration: animDuration,
              easing: Easing.easeOut,
            })
            console.log(`[Live2D] 状态自动重置: ${stateId}`)
          }, actualDuration * 1000)
        }
      },
      listStates: () => {
        const faces = Object.values(CHARACTER_STATES)
          .filter((s) => s.type === 1)
          .map((s) => s.id)
        const actions = Object.values(CHARACTER_STATES)
          .filter((s) => s.type === 2)
          .map((s) => s.id)
        return { faces, actions }
      },
      states: CHARACTER_STATES,
    }

    ;(window as any).live2dDebug = debugAPI
    return debugAPI
  }

  /** 清理调试API */
  const cleanupDebugAPI = () => {
    if ((window as any).live2dDebug) {
      delete (window as any).live2dDebug
    }
  }

  return {
    setupDebugAPI,
    cleanupDebugAPI,
  }
}
