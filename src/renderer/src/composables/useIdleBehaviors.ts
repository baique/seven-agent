import { ref, type Ref } from 'vue'
import type { CubismModelWrapper } from '../live2d/CubismModelWrapper'
import type { ParamAnimator } from '../state/paramAnimator'
import { Easing } from '../state/paramAnimator'

/** 呼吸动画配置 */
export interface BreathConfig {
  /** 是否启用 */
  enabled: boolean
  /** 呼吸周期（毫秒） */
  cycleDuration: number
}

/** 默认呼吸配置 */
const DEFAULT_BREATH: BreathConfig = {
  enabled: true,
  cycleDuration: 6000, // 6秒一个周期，更慢更平滑
}

/** 空闲行为选项 */
export interface IdleBehaviorOptions {
  /** 模型引用 */
  model: Ref<CubismModelWrapper | null>
  /** 动画器引用 */
  animator: { value: ParamAnimator | null }
  /** 是否启用 */
  enabled: Ref<boolean>
  /** 是否偏好减少动画（无障碍） */
  prefersReducedMotion: boolean
  /** 设置渲染前回调，用于在物理系统之前设置参数 */
  setBeforeUpdateCallback?: (callback: (() => void) | null) => void
  /** 空闲行为配置路径（已废弃，保留兼容性） */
  idleBehaviorsPath?: string
  /** 行为开始回调（已废弃，保留兼容性） */
  onBehaviorStart?: (id: string) => void
  /** 行为结束回调（已废弃，保留兼容性） */
  onBehaviorEnd?: () => void
}

/**
 * 空闲行为组合式函数
 * 通过 ParamBreath 驱动尾巴物理摆动
 * @param options 空闲行为选项
 * @returns 空闲行为控制方法
 */
export function useIdleBehaviors(options: IdleBehaviorOptions) {
  /** 呼吸动画配置 */
  const breathConfig = ref<BreathConfig>({
    ...DEFAULT_BREATH,
    enabled: !options.prefersReducedMotion,
  })
  /** 呼吸动画开始时间 */
  let breathStartTime = 0
  /** 当前呼吸相位偏移（用于随机化） */
  let breathPhaseOffset = Math.random() * Math.PI * 2
  /** 摆动状态：'idle' 静止, 'wagging' 摆动中 */
  let wagState: 'idle' | 'wagging' = 'idle'
  /** 下次状态变化时间 */
  let nextStateChangeTime = 0
  /** 当前摆动进度 */
  let wagProgress = 0
  /** 当前摆动周期 */
  let currentWagDuration = 3000
  /** 摆动目标值（用于平滑过渡） */
  let targetWagValue = 0
  /** 当前摆动值（用于平滑过渡） */
  let currentWagValue = 0

  /**
   * 呼吸动画回调函数
   * 通过 ParamBreath 驱动尾巴物理摆动
   * 大幅度平滑摆动，像猫尾巴一样慵懒地扫动
   * 在 m.update() 之前执行，确保参数在物理系统计算前设置
   */
  const breathCallback = () => {
    const m = options.model.value
    const config = breathConfig.value

    if (!m || !config.enabled) return

    const now = performance.now()
    if (breathStartTime === 0) {
      breathStartTime = now
      // 初始状态：静止一段时间
      wagState = 'idle'
      nextStateChangeTime = now + 2000 + Math.random() * 3000 // 2-5秒后第一次摆动
    }

    const elapsed = now - breathStartTime

    // 检查是否需要切换状态
    if (now >= nextStateChangeTime) {
      if (wagState === 'idle') {
        // 开始摆动
        wagState = 'wagging'
        wagProgress = 0
        currentWagDuration = 2000 + Math.random() * 2000 // 摆动持续 2-4秒
        nextStateChangeTime = now + currentWagDuration
        // 随机决定这次摆动的幅度方向
        targetWagValue = 0.6 + Math.random() * 0.35 // 0.6 - 0.95 大幅度
      } else {
        // 停止摆动，进入静止
        wagState = 'idle'
        nextStateChangeTime = now + 3000 + Math.random() * 5000 // 静止 3-8秒
        targetWagValue = 0.1 + Math.random() * 0.15 // 静止时小幅值 0.1-0.25
      }
    }

    // 平滑过渡到目标值（关键：大平滑度，避免抽搐）
    const smoothFactor = wagState === 'wagging' ? 0.008 : 0.003
    currentWagValue += (targetWagValue - currentWagValue) * smoothFactor

    let breathValue = currentWagValue

    if (wagState === 'wagging') {
      // 摆动状态：大幅度平滑扫动
      wagProgress = (now - (nextStateChangeTime - currentWagDuration)) / currentWagDuration

      // 使用缓动函数创造平滑的加速和减速
      const easeInOut = Math.sin(wagProgress * Math.PI)

      // 大范围的扫动波形（只摆动1-2次，不是快速抖动）
      const wagCycle = Math.sin(wagProgress * Math.PI * 1.5) * easeInOut

      // 叠加到基础值上，创造大幅度的摆动
      breathValue = currentWagValue + wagCycle * 0.4
    }

    // 限制在 0-1 范围内
    breathValue = Math.max(0, Math.min(1, breathValue))

    m.setExternalInputParameter('ParamBreath', breathValue)
  }

  /**
   * 启动呼吸动画
   */
  const startBreathAnimation = () => {
    console.log('[IdleBehaviors] startBreathAnimation 被调用', {
      prefersReducedMotion: options.prefersReducedMotion,
      enabled: breathConfig.value.enabled,
      hasSetBeforeUpdateCallback: !!options.setBeforeUpdateCallback,
    })

    if (options.prefersReducedMotion) {
      console.log('[IdleBehaviors] 跳过：无障碍模式')
      return // 无障碍模式不启用
    }

    if (!breathConfig.value.enabled) {
      console.log('[IdleBehaviors] 跳过：配置已禁用')
      return
    }

    breathStartTime = 0
    breathPhaseOffset = Math.random() * Math.PI * 2 // 随机初始相位

    // 注册回调到渲染循环，在 m.update() 之前执行
    if (options.setBeforeUpdateCallback) {
      options.setBeforeUpdateCallback(breathCallback)
      console.log('[IdleBehaviors] 回调已注册')
    } else {
      console.log('[IdleBehaviors] 警告：setBeforeUpdateCallback 未提供')
    }
  }

  /**
   * 停止呼吸动画
   * 平滑地重置参数到默认值
   */
  const stopBreathAnimation = async () => {
    // 取消回调注册
    options.setBeforeUpdateCallback?.(null)

    const m = options.model.value
    if (!m) return

    // 清除呼吸参数输入
    m.clearExternalInputParameter('ParamBreath')

    // 平滑地重置呼吸参数
    const animator = options.animator.value
    if (animator) {
      await animator.animateMultiple([{ name: 'ParamBreath', value: 0 }], {
        duration: 500,
        easing: Easing.easeOut,
      })
    }
  }

  /**
   * 更新呼吸配置
   * @param config 新的配置（部分更新）
   */
  const updateBreathConfig = (config: Partial<BreathConfig>) => {
    const wasEnabled = breathConfig.value.enabled
    breathConfig.value = {
      ...breathConfig.value,
      ...config,
    }

    // 如果禁用了呼吸动画，停止它
    if (config.enabled === false) {
      stopBreathAnimation()
    } else if (config.enabled === true && !wasEnabled) {
      // 从禁用状态切换到启用状态，启动呼吸动画
      startBreathAnimation()
    }
  }

  /** 启动空闲行为系统 */
  const startIdleBehaviors = async () => {
    // 启动呼吸动画（通过 ParamBreath 驱动尾巴物理摆动）
    startBreathAnimation()
  }

  /** 停止空闲行为系统 */
  const stopIdleBehaviors = () => {
    // 停止呼吸动画
    stopBreathAnimation()
  }

  return {
    startIdleBehaviors,
    stopIdleBehaviors,
    breathConfig,
    startBreathAnimation,
    stopBreathAnimation,
    updateBreathConfig,
  }
}
