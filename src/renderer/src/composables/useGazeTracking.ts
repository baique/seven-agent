import { type Ref } from 'vue'
import type { CubismModelWrapper } from '../live2d/CubismModelWrapper'

/** 视线追踪选项 */
export interface GazeTrackingOptions {
  /** 模型引用 */
  model: Ref<CubismModelWrapper | null>
  /** 是否启用追踪 */
  enabled: Ref<boolean>
}

/** 视线追踪配置 */
interface GazeConfig {
  /** 眼球跟随灵敏度 (0-1) */
  eyeResponsiveness: number
  /** 头部跟随灵敏度 (0-1) */
  headResponsiveness: number
  /** 身体跟随灵敏度 (0-1) */
  bodyResponsiveness: number
  /** 最大眼球偏移 */
  maxEyeOffset: number
  /** 最大头部角度 */
  maxHeadAngle: number
  /** 最大身体角度 */
  maxBodyAngle: number
  /** 空闲微动幅度 */
  idleWanderAmplitude: number
  /** 空闲微动频率 (周期/秒) */
  idleWanderFrequency: number
  /** 鼠标静止判定时间 (ms) */
  idleThreshold: number
  /** 兴趣点偏移概率 */
  interestPointChance: number
  /** 兴趣点持续时间 (ms) */
  interestPointDuration: number
}

/** 默认配置 */
const DEFAULT_CONFIG: GazeConfig = {
  eyeResponsiveness: 0.15, // 眼球较快跟随
  headResponsiveness: 0.04, // 头部较慢
  bodyResponsiveness: 0.015, // 身体最慢
  maxEyeOffset: 1.0, // 眼球最大范围
  maxHeadAngle: 12, // 头部最大角度
  maxBodyAngle: 6, // 身体最大角度
  idleWanderAmplitude: 0.08, // 空闲微动幅度
  idleWanderFrequency: 0.3, // 空闲微动频率
  idleThreshold: 2000, // 2秒无移动进入空闲
  interestPointChance: 0.02, // 2%概率产生兴趣点偏移
  interestPointDuration: 1500, // 兴趣点持续1.5秒
}

/**
 * 视线追踪组合式函数 - 基于物理的平滑跟随系统
 *
 * 核心设计：
 * 1. 分层控制：眼球(快) → 头部(中) → 身体(慢)，产生自然的物理滞后感
 * 2. 平滑插值：使用不同时间常数模拟真实人类视线的物理特性
 * 3. 空闲微动：鼠标静止时视线有微小随机漂移，保持"活着"的感觉
 * 4. 兴趣点机制：偶尔视线会在鼠标附近随机偏移，模拟注意力分散
 *
 * @param options 视线追踪选项
 * @returns 视线追踪控制方法
 */
export function useGazeTracking(options: GazeTrackingOptions) {
  const config: GazeConfig = { ...DEFAULT_CONFIG }

  // 当前各层级的视线目标值
  let currentEyeX = 0
  let currentEyeY = 0
  let currentHeadX = 0
  let currentHeadY = 0
  let currentBodyX = 0
  let currentBodyY = 0

  // 目标位置（由鼠标计算得出）
  let targetX = 0
  let targetY = 0

  // 兴趣点偏移
  let interestOffsetX = 0
  let interestOffsetY = 0
  let interestPointTimeout: ReturnType<typeof setTimeout> | null = null

  // 空闲状态
  let lastMouseMoveTime = 0
  let isIdle = false
  let idlePhase = Math.random() * Math.PI * 2

  // 鼠标位置历史（用于计算速度）
  let lastMouseX = 0
  let lastMouseY = 0

  /**
   * 计算鼠标相对模型的目标位置
   * 将屏幕坐标转换为 -1 到 1 的范围
   */
  const calculateTarget = (mouseX: number, mouseY: number, modelX: number, modelY: number) => {
    const screenCenterX = window.innerWidth / 2
    const screenCenterY = window.innerHeight / 2
    const modelScreenX = screenCenterX + modelX
    const modelScreenY = screenCenterY + modelY

    const dx = mouseX - modelScreenX
    const dy = mouseY - modelScreenY
    const distance = Math.sqrt(dx * dx + dy * dy)

    // 限制最大响应距离，超过此距离目标值不再增加
    const maxDistance = 600
    const clampedDistance = Math.min(distance, maxDistance)
    const scale = distance > 0 ? clampedDistance / distance : 0

    // 转换为 -1 到 1 的范围
    // X轴：负值向左看，正值向右看
    // Y轴：负值向上看，正值向下看（屏幕坐标Y向下为正，需要反转）
    const baseX = (dx * scale) / maxDistance
    const baseY = -(dy * scale) / maxDistance

    return {
      targetX: Math.max(-1, Math.min(1, baseX)),
      targetY: Math.max(-1, Math.min(1, baseY)),
      distance,
    }
  }

  /**
   * 生成新的兴趣点偏移
   * 在鼠标位置附近随机偏移，模拟注意力分散
   */
  const generateInterestPoint = () => {
    // 在鼠标周围随机偏移
    const angle = Math.random() * Math.PI * 2
    const radius = 0.15 + Math.random() * 0.25 // 0.15 - 0.4 的偏移范围

    interestOffsetX = Math.cos(angle) * radius
    interestOffsetY = Math.sin(angle) * radius

    // 清除之前的定时器
    if (interestPointTimeout) {
      clearTimeout(interestPointTimeout)
    }

    // 一段时间后清除兴趣点
    interestPointTimeout = setTimeout(() => {
      interestOffsetX = 0
      interestOffsetY = 0
    }, config.interestPointDuration)
  }

  /**
   * 更新视线目标位置
   * 每帧调用，实现平滑的物理跟随效果
   *
   * @param mouseX 鼠标X坐标（CSS像素）
   * @param mouseY 鼠标Y坐标（CSS像素）
   * @param modelX 模型X坐标（CSS像素，相对屏幕中心）
   * @param modelY 模型Y坐标（CSS像素，相对屏幕中心）
   */
  const updateTarget = (mouseX: number, mouseY: number, modelX: number, modelY: number) => {
    const m = options.model.value
    if (!m || !options.enabled.value) return

    const now = Date.now()

    // 计算鼠标移动速度
    const mouseSpeed = Math.sqrt(
      Math.pow(mouseX - lastMouseX, 2) + Math.pow(mouseY - lastMouseY, 2),
    )

    // 更新鼠标位置历史
    lastMouseX = mouseX
    lastMouseY = mouseY

    // 如果有移动，更新最后移动时间
    if (mouseSpeed > 1) {
      lastMouseMoveTime = now
      isIdle = false
    }

    // 检查是否进入空闲状态
    if (!isIdle && now - lastMouseMoveTime > config.idleThreshold) {
      isIdle = true
      idlePhase = Math.random() * Math.PI * 2
    }

    // 计算基础目标位置
    const { targetX: newTargetX, targetY: newTargetY } = calculateTarget(
      mouseX,
      mouseY,
      modelX,
      modelY,
    )

    // 随机产生兴趣点
    if (Math.random() < config.interestPointChance) {
      generateInterestPoint()
    }

    // 应用兴趣点偏移
    targetX = newTargetX + interestOffsetX
    targetY = newTargetY + interestOffsetY

    // 限制在有效范围内
    targetX = Math.max(-1.2, Math.min(1.2, targetX))
    targetY = Math.max(-1.2, Math.min(1.2, targetY))

    // 分层平滑插值 - 模拟物理滞后
    // 眼球：快速响应
    currentEyeX += (targetX - currentEyeX) * config.eyeResponsiveness
    currentEyeY += (targetY - currentEyeY) * config.eyeResponsiveness

    // 头部：中等速度
    currentHeadX += (targetX - currentHeadX) * config.headResponsiveness
    currentHeadY += (targetY - currentHeadY) * config.headResponsiveness

    // 身体：最慢
    currentBodyX += (targetX - currentBodyX) * config.bodyResponsiveness
    currentBodyY += (targetY - currentBodyY) * config.bodyResponsiveness

    // 空闲时的微动
    if (isIdle) {
      const time = now / 1000
      const wanderX =
        Math.sin(time * config.idleWanderFrequency + idlePhase) * config.idleWanderAmplitude
      const wanderY =
        Math.cos(time * config.idleWanderFrequency * 0.7 + idlePhase) * config.idleWanderAmplitude

      currentEyeX += wanderX * 0.5
      currentEyeY += wanderY * 0.5
    }

    // 应用参数到模型
    // 眼球参数：ParamEyeBallX, ParamEyeBallY
    m.setExternalParameter('ParamEyeBallX', currentEyeX * config.maxEyeOffset)
    m.setExternalParameter('ParamEyeBallY', currentEyeY * config.maxEyeOffset)

    // 头部参数：ParamAngleX, ParamAngleY
    m.setExternalParameter('ParamAngleX', currentHeadX * config.maxHeadAngle)
    m.setExternalParameter('ParamAngleY', currentHeadY * config.maxHeadAngle)

    // 头部Z轴旋转：根据X轴移动产生轻微旋转
    const headZRotation = -currentHeadX * 3 // 轻微旋转
    m.setExternalParameter('ParamAngleZ', headZRotation)

    // 身体参数：ParamBodyAngleX, ParamBodyAngleY
    m.setExternalParameter('ParamBodyAngleX', currentBodyX * config.maxBodyAngle)
    m.setExternalParameter('ParamBodyAngleY', Math.abs(currentBodyY) * config.maxBodyAngle * 0.5)
  }

  /**
   * 停止视线追踪
   * 平滑地将视线回正到中心
   */
  const stopTracking = () => {
    // 清除兴趣点定时器
    if (interestPointTimeout) {
      clearTimeout(interestPointTimeout)
      interestPointTimeout = null
    }

    // 重置所有参数
    const m = options.model.value
    if (m) {
      m.setExternalParameter('ParamEyeBallX', 0)
      m.setExternalParameter('ParamEyeBallY', 0)
      m.setExternalParameter('ParamAngleX', 0)
      m.setExternalParameter('ParamAngleY', 0)
      m.setExternalParameter('ParamAngleZ', 0)
      m.setExternalParameter('ParamBodyAngleX', 0)
      m.setExternalParameter('ParamBodyAngleY', 0)
    }

    // 重置内部状态
    currentEyeX = 0
    currentEyeY = 0
    currentHeadX = 0
    currentHeadY = 0
    currentBodyX = 0
    currentBodyY = 0
    targetX = 0
    targetY = 0
    interestOffsetX = 0
    interestOffsetY = 0
    isIdle = false
  }

  /**
   * 重置视线到中心
   * 立即重置，不经过平滑过渡
   */
  const resetGaze = () => {
    stopTracking()
  }

  /**
   * 更新配置
   * @param newConfig 新的配置（部分更新）
   */
  const updateConfig = (newConfig: Partial<GazeConfig>) => {
    Object.assign(config, newConfig)
  }

  return {
    stopTracking,
    updateTarget,
    resetGaze,
    updateConfig,
  }
}
