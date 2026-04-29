export type EasingFunction = (t: number) => number

export const Easing = {
  linear: (t: number) => t,
  easeOut: (t: number) => 1 - Math.pow(1 - t, 3),
  easeInOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeOutElastic: (t: number) => {
    if (t === 0 || t === 1) return t
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
  },
}

export interface AnimationOptions {
  duration?: number
  easing?: EasingFunction
}

interface AnimatingParam {
  paramName: string
  startValue: number
  targetValue: number
  startTime: number
  duration: number
  easing: EasingFunction
  onComplete?: () => void
}

/**
 * 参数动画器
 * 通过回调函数设置模型参数，支持缓动动画、摇摆、呼吸、摇尾巴等效果
 */
export class ParamAnimator {
  private _setParameter: (name: string, value: number) => void
  private _getParameter: (name: string) => number
  private animations: Map<string, AnimatingParam> = new Map()
  private rafId: number | null = null
  private isRunning = false

  /**
   * @param setParameter 设置参数值的回调
   * @param getParameter 获取参数值的回调
   */
  constructor(
    setParameter: (name: string, value: number) => void,
    getParameter: (name: string) => number,
  ) {
    this._setParameter = setParameter
    this._getParameter = getParameter
  }

  animate(paramName: string, targetValue: number, options: AnimationOptions = {}): Promise<void> {
    const duration = options.duration ?? 300
    const easing = options.easing ?? Easing.easeOut

    return new Promise((resolve) => {
      const currentValue = this._getParameter(paramName)

      if (Math.abs(currentValue - targetValue) < 0.001) {
        resolve()
        return
      }

      this.animations.set(paramName, {
        paramName,
        startValue: currentValue,
        targetValue,
        startTime: performance.now(),
        duration,
        easing,
        onComplete: resolve,
      })

      if (!this.isRunning) {
        this.startLoop()
      }
    })
  }

  animateMultiple(
    params: Array<{ name: string; value: number }>,
    options: AnimationOptions = {},
  ): Promise<void[]> {
    const promises = params.map((p) => this.animate(p.name, p.value, options))
    return Promise.all(promises)
  }

  set(paramName: string, value: number): void {
    this.animations.delete(paramName)
    this._setParameter(paramName, value)
  }

  stop(paramName: string): void {
    this.animations.delete(paramName)
  }

  stopAll(): void {
    this.animations.clear()
  }

  private startLoop(): void {
    this.isRunning = true
    this.loop()
  }

  private loop(): void {
    const now = performance.now()
    const toDelete: string[] = []

    this.animations.forEach((anim) => {
      const elapsed = now - anim.startTime
      const progress = Math.min(elapsed / anim.duration, 1)
      const easedProgress = anim.easing(progress)
      const currentValue = anim.startValue + (anim.targetValue - anim.startValue) * easedProgress

      this._setParameter(anim.paramName, currentValue)

      if (progress >= 1) {
        toDelete.push(anim.paramName)
        anim.onComplete?.()
      }
    })

    toDelete.forEach((name) => this.animations.delete(name))

    if (this.animations.size > 0) {
      this.rafId = requestAnimationFrame(() => this.loop())
    } else {
      this.isRunning = false
      this.rafId = null
    }
  }

  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
    }
    this.animations.clear()
    this.isRunning = false
  }

  startWobble(
    paramName: string,
    options: {
      amplitude?: number
      frequency?: number
      duration?: number
      fadeInDuration?: number
      fadeOutDuration?: number
    } = {},
  ): Promise<void> {
    const amplitude = options.amplitude ?? 1
    const frequency = options.frequency ?? 2
    const duration = options.duration ?? 2000
    const fadeInDuration = options.fadeInDuration ?? 300
    const fadeOutDuration = options.fadeOutDuration ?? 500

    return new Promise((resolve) => {
      const startTime = performance.now()
      const startValue = this._getParameter(paramName)

      const animate = () => {
        const elapsed = performance.now() - startTime
        const progress = elapsed / duration

        if (progress >= 1) {
          this._setParameter(paramName, startValue)
          resolve()
          return
        }

        let fadeMultiplier = 1
        const fadeInProgress = Math.min(elapsed / fadeInDuration, 1)
        const fadeOutStart = duration - fadeOutDuration
        const fadeOutProgress =
          elapsed < fadeOutStart ? 0 : (elapsed - fadeOutStart) / fadeOutDuration

        fadeMultiplier = fadeInProgress * (1 - fadeOutProgress)

        const wobble = Math.sin(progress * Math.PI * 2 * frequency) * amplitude * fadeMultiplier

        this._setParameter(paramName, startValue + wobble)

        requestAnimationFrame(animate)
      }

      animate()
    })
  }

  startMultiParamWobble(
    params: Array<{
      name: string
      amplitude: number
      frequency?: number
    }>,
    options: {
      duration?: number
      fadeInDuration?: number
      fadeOutDuration?: number
    } = {},
  ): Promise<void> {
    const duration = options.duration ?? 2000
    const fadeInDuration = options.fadeInDuration ?? 300
    const fadeOutDuration = options.fadeOutDuration ?? 500

    const startValues = new Map<string, number>()
    for (const p of params) {
      startValues.set(p.name, this._getParameter(p.name))
    }

    return new Promise((resolve) => {
      const startTime = performance.now()

      const animate = () => {
        const elapsed = performance.now() - startTime
        const progress = elapsed / duration

        if (progress >= 1) {
          for (const p of params) {
            this._setParameter(p.name, startValues.get(p.name)!)
          }
          resolve()
          return
        }

        let fadeMultiplier = 1
        const fadeInProgress = Math.min(elapsed / fadeInDuration, 1)
        const fadeOutStart = duration - fadeOutDuration
        const fadeOutProgress =
          elapsed < fadeOutStart ? 0 : (elapsed - fadeOutStart) / fadeOutDuration

        fadeMultiplier = fadeInProgress * (1 - fadeOutProgress)

        for (const p of params) {
          const frequency = p.frequency ?? 2
          const wobble = Math.sin(progress * Math.PI * 2 * frequency) * p.amplitude * fadeMultiplier
          const startVal = startValues.get(p.name)!
          this._setParameter(p.name, startVal + wobble)
        }

        requestAnimationFrame(animate)
      }

      animate()
    })
  }

  startBreathingMotion(
    params: Array<{
      name: string
      targetValue: number
    }>,
    options: {
      duration?: number
      holdDuration?: number
      easeInDuration?: number
      easeOutDuration?: number
    } = {},
  ): Promise<void> {
    const duration = options.duration ?? 3000
    const holdDuration = options.holdDuration ?? 500
    const easeInDuration = options.easeInDuration ?? 800
    const easeOutDuration = options.easeOutDuration ?? 800

    const startValues = new Map<string, number>()
    for (const p of params) {
      startValues.set(p.name, this._getParameter(p.name))
    }

    return new Promise((resolve) => {
      const startTime = performance.now()

      const animate = () => {
        const elapsed = performance.now() - startTime
        const totalDuration = duration + holdDuration
        const progress = elapsed / totalDuration

        if (progress >= 1) {
          for (const p of params) {
            this._setParameter(p.name, startValues.get(p.name)!)
          }
          resolve()
          return
        }

        let easedProgress: number

        if (progress < duration / totalDuration) {
          const riseProgress = elapsed / duration
          if (riseProgress < easeInDuration / duration) {
            easedProgress = Easing.easeOut((riseProgress * duration) / easeInDuration) * 0.5
          } else {
            easedProgress = 0.5
          }
        } else {
          const fallElapsed = elapsed - duration
          const fallProgress = Math.min(fallElapsed / easeOutDuration, 1)
          easedProgress = 0.5 * (1 - Easing.easeOut(fallProgress))
        }

        for (const p of params) {
          const startVal = startValues.get(p.name)!
          const targetVal = p.targetValue
          const currentVal = startVal + (targetVal - startVal) * easedProgress * 2
          this._setParameter(p.name, currentVal)
        }

        requestAnimationFrame(animate)
      }

      animate()
    })
  }

  startTailWag(
    tailParamName: string,
    options: {
      amplitude?: number
      duration?: number
      direction?: 'left' | 'right' | 'random'
    } = {},
  ): Promise<void> {
    const amplitude = options.amplitude ?? 0.8
    const duration = options.duration ?? 600
    const direction = options.direction ?? (Math.random() > 0.5 ? 'right' : 'left')

    const targetValue = direction === 'right' ? amplitude : -amplitude

    return new Promise((resolve) => {
      const startValue = this._getParameter(tailParamName)
      const startTime = performance.now()

      const animate = () => {
        const elapsed = performance.now() - startTime
        const progress = elapsed / duration

        if (progress >= 1) {
          this._setParameter(tailParamName, startValue)
          resolve()
          return
        }

        const easedProgress = Easing.easeOut(progress)
        const wobble = targetValue * Math.sin(progress * Math.PI) * easedProgress
        this._setParameter(tailParamName, startValue + wobble)

        requestAnimationFrame(animate)
      }

      animate()
    })
  }
}
