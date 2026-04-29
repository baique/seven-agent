import { ref, watch, onMounted, onUnmounted, inject, type Ref } from 'vue'

/** 面板模式 */
export type PanelMode = 'follow' | 'independent'

/** 面板展开方向 */
export type ExpandDirection = 'left' | 'right'

/** 面板类型 */
export type PanelType = 'personality' | 'terminal' | 'task' | 'history'

/** 人物位置信息 */
export interface ModelPosition {
  x: number
  y: number
  width: number
  height: number
}

/** 面板跟随侧配置 */
export type PanelSide = 'left' | 'right'

/** 面板边界信息 */
interface PanelBounds {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

/** 面板事件回调配置 */
export interface PanelEventCallbacks {
  /** 悬浮展开回调 */
  onHoverEnter?: (panelType: PanelType) => void
  /** 离开收起回调 */
  onHoverLeave?: (panelType: PanelType) => void
  /** 锁定回调 */
  onLock?: (panelType: PanelType) => void
  /** 解锁回调 */
  onUnlock?: (panelType: PanelType) => void
  /** 模式切换回调 */
  onModeChange?: (panelType: PanelType, mode: PanelMode) => void
  /** CSS 过渡/动画结束回调 */
  onTransitionEnd?: (panelType: PanelType, event: TransitionEvent) => void
}

/** composable 返回值 */
export interface UsePanelPositionReturn {
  /** 当前模式 */
  mode: Ref<PanelMode>
  /** 展开方向 */
  expandDirection: Ref<ExpandDirection>
  /** 是否正在模式切换动画中 */
  isAnimating: Ref<boolean>
  /** 切换跟随/独立模式 */
  toggleMode: () => void
  /** 重置为跟随模式 */
  resetToFollow: () => void
  /** 展开时检查边界 */
  checkBounds: () => void
  /** 是否处于可跟随区域 */
  isInFollowZone: Ref<boolean>
  /** 是否悬浮 */
  isHovered: Ref<boolean>
  /** 是否锁定 */
  isLocked: Ref<boolean>
  /** 鼠标进入处理 */
  handleMouseEnter: () => void
  /** 鼠标离开处理 */
  handleMouseLeave: () => void
  /** 切换锁定状态 */
  handleToggleLock: () => void
}

const MODEL_POSITION_KEY = 'modelPosition'
const IS_CHARACTER_HIDDEN_KEY = 'isCharacterHidden'
const STORAGE_KEY = 'panel-pos-v4'

/** 距离检测配置 */
const PROXIMITY_CONFIG = {
  /** 水平方向边缘阈值（像素） */
  HORIZONTAL_THRESHOLD: 200,
  /** 垂直方向边缘阈值（像素） */
  VERTICAL_THRESHOLD: 100,
  /** 防抖延迟（毫秒） */
  DEBOUNCE_DELAY: 300,
}

/** 各面板默认跟随侧和垂直偏移 */
const PANEL_DEFAULTS: Record<PanelType, { side: PanelSide; verticalOffset: number }> = {
  history: { side: 'left', verticalOffset: 120 },
  task: { side: 'left', verticalOffset: 330 },
  terminal: { side: 'right', verticalOffset: 100 },
  personality: { side: 'right', verticalOffset: 390 },
}

/** 面板优先级（用于避让决策） */
const PANEL_PRIORITY: Record<PanelType, number> = {
  history: 1,
  task: 2,
  terminal: 3,
  personality: 4,
}

/** 加载面板持久化数据 */
function loadPersist(panelType: PanelType): {
  mode: PanelMode
  x: number
  y: number
  followOffsetX?: number
  followOffsetY?: number
} {
  try {
    const saved = localStorage.getItem(`${STORAGE_KEY}-${panelType}`)
    if (saved) return JSON.parse(saved)
  } catch {
    // ignore
  }
  return { mode: 'follow', x: 0, y: 0, followOffsetX: 0, followOffsetY: 0 }
}

/** 保存面板持久化数据 */
function savePersist(
  panelType: PanelType,
  mode: PanelMode,
  x: number,
  y: number,
  followOffsetX?: number,
  followOffsetY?: number,
): void {
  try {
    localStorage.setItem(
      `${STORAGE_KEY}-${panelType}`,
      JSON.stringify({ mode, x, y, followOffsetX, followOffsetY }),
    )
  } catch {
    // ignore
  }
}

/** 全局面板位置管理器 */
class PanelPositionManager {
  private panels = new Map<PanelType, { ref: Ref<HTMLElement | null>; priority: number }>()
  private COLLISION_GAP = 10 // 面板之间的最小间距

  register(panelType: PanelType, panelRef: Ref<HTMLElement | null>) {
    this.panels.set(panelType, { ref: panelRef, priority: PANEL_PRIORITY[panelType] })
  }

  unregister(panelType: PanelType) {
    this.panels.delete(panelType)
  }

  /** 获取所有面板的边界信息 */
  getAllPanelBounds(): Array<{ type: PanelType; bounds: PanelBounds }> {
    const bounds: Array<{ type: PanelType; bounds: PanelBounds }> = []
    this.panels.forEach((panel, type) => {
      const el = panel.ref.value
      if (el) {
        const rect = el.getBoundingClientRect()
        bounds.push({
          type,
          bounds: {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
          },
        })
      }
    })
    return bounds
  }

  /** 检查两个面板是否重叠 */
  private isOverlapping(a: PanelBounds, b: PanelBounds): boolean {
    return !(
      a.right + this.COLLISION_GAP < b.left ||
      b.right + this.COLLISION_GAP < a.left ||
      a.bottom + this.COLLISION_GAP < b.top ||
      b.bottom + this.COLLISION_GAP < a.top
    )
  }

  /** 计算避让偏移量 */
  calculateAvoidanceOffset(
    selfType: PanelType,
    selfBounds: PanelBounds,
    maxIterations = 3,
  ): { dx: number; dy: number } {
    let dx = 0
    let dy = 0
    const selfPriority = PANEL_PRIORITY[selfType]

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      let hasCollision = false
      const currentBounds: PanelBounds = {
        ...selfBounds,
        left: selfBounds.left + dx,
        right: selfBounds.right + dx,
        top: selfBounds.top + dy,
        bottom: selfBounds.bottom + dy,
      }

      const allBounds = this.getAllPanelBounds()

      for (const other of allBounds) {
        if (other.type === selfType) continue

        if (this.isOverlapping(currentBounds, other.bounds)) {
          hasCollision = true
          const otherPriority = PANEL_PRIORITY[other.type]

          // 优先级低的面板避让优先级高的
          if (selfPriority < otherPriority) {
            // 计算避让方向
            const overlapLeft = currentBounds.right - other.bounds.left
            const overlapRight = other.bounds.right - currentBounds.left
            const overlapTop = currentBounds.bottom - other.bounds.top
            const overlapBottom = other.bounds.bottom - currentBounds.top

            const minOverlap = Math.min(overlapLeft, overlapRight, overlapTop, overlapBottom)

            if (minOverlap === overlapLeft) {
              dx -= overlapLeft + this.COLLISION_GAP
            } else if (minOverlap === overlapRight) {
              dx += overlapRight + this.COLLISION_GAP
            } else if (minOverlap === overlapTop) {
              dy -= overlapTop + this.COLLISION_GAP
            } else {
              dy += overlapBottom + this.COLLISION_GAP
            }
          }
        }
      }

      if (!hasCollision) break
    }

    return { dx, dy }
  }

  /** 确保面板在屏幕内 - 直接计算目标位置，避免偏移量叠加导致的回弹 */
  ensureInScreen(
    bounds: PanelBounds,
    proposedLeft: number,
    proposedTop: number,
  ): { left: number; top: number } {
    const MARGIN = 20 // 屏幕边缘留白
    const left = proposedLeft
    const top = proposedTop

    // 水平方向检查 - 确保面板不会超出屏幕
    // if (left < MARGIN) {
    //   left = MARGIN
    // } else if (left + bounds.width > window.innerWidth - MARGIN) {
    //   left = window.innerWidth - MARGIN - bounds.width
    // }

    // // 垂直方向检查
    // if (top < MARGIN) {
    //   top = MARGIN
    // } else if (top + bounds.height > window.innerHeight - MARGIN) {
    //   top = window.innerHeight - MARGIN - bounds.height
    // }

    return { left, top }
  }
}

// 全局单例
const panelManager = new PanelPositionManager()

/**
 * 面板位置管理 composable
 */
export function usePanelPosition(
  panelType: PanelType,
  panelRef: Ref<HTMLElement | null>,
  verticalOffset: number | Ref<number>,
  callbacks?: PanelEventCallbacks,
): UsePanelPositionReturn {
  const modelPosition = inject<Ref<ModelPosition>>(MODEL_POSITION_KEY)!
  const isCharacterHidden = inject<Ref<boolean>>(IS_CHARACTER_HIDDEN_KEY, ref(false))

  const defaults = PANEL_DEFAULTS[panelType]
  const side = defaults.side

  const verticalOffsetRef =
    typeof verticalOffset === 'number' ? ref(verticalOffset) : verticalOffset

  const persist = loadPersist(panelType)
  const mode = ref<PanelMode>(persist.mode)
  const screenX = ref(persist.x)
  const screenY = ref(persist.y)
  const expandDirection = ref<ExpandDirection>(side === 'left' ? 'left' : 'right')
  const isAnimating = ref(false)
  let animTimer: ReturnType<typeof setTimeout> | null = null

  const GAP = 35
  const PANEL_WIDTH = 300
  const PANEL_HEIGHT = 40 // 收起状态高度

  /** 跟随模式下的拖拽偏移量（相对于默认位置） */
  const followOffsetX = ref(persist.followOffsetX ?? 0)
  const followOffsetY = ref(persist.followOffsetY ?? 0)

  /** 是否处于可跟随区域 */
  const isInFollowZone = ref(true)

  /** 悬浮和锁定状态 */
  const isHovered = ref(false)
  const isLocked = ref(false)

  /** Timer 引用 */
  let leaveTimer: ReturnType<typeof setTimeout> | null = null
  let enterTimer: ReturnType<typeof setTimeout> | null = null
  let checkBoundsTimer: ReturnType<typeof setTimeout> | null = null

  /** 人物是否已加载 */
  const isModelReady = () => modelPosition.value.width > 0

  /**
   * 检测面板是否处于可跟随区域
   * @param panelLeft 面板左侧坐标
   * @param panelTop 面板上侧坐标
   * @param panelWidth 面板宽度
   * @returns 是否在可跟随区域内
   */
  const checkInFollowZone = (panelLeft: number, panelTop: number, panelWidth: number): boolean => {
    const m = modelPosition.value
    if (m.width === 0) return true // 人物未加载时默认在跟随区

    const modelLeft = m.x - m.width / 2
    const modelRight = m.x + m.width / 2
    // 垂直方向以人物中心为基准，上下各一半高度
    const modelTop = m.y - m.height / 2 - 60
    const modelBottom = m.y + m.height / 2

    const panelRight = panelLeft + panelWidth

    // 水平方向检测：考虑面板在人物左侧或右侧的情况
    // 面板在人物左侧：检测面板右侧是否贴近人物左侧
    // 面板在人物右侧：检测面板左侧是否贴近人物右侧
    let horizontalInZone = false
    if (panelRight <= modelLeft) {
      // 面板在人物左侧
      const distanceToModel = modelLeft - panelRight
      horizontalInZone = distanceToModel <= PROXIMITY_CONFIG.HORIZONTAL_THRESHOLD
    } else if (panelLeft >= modelRight) {
      // 面板在人物右侧
      const distanceToModel = panelLeft - modelRight
      horizontalInZone = distanceToModel <= PROXIMITY_CONFIG.HORIZONTAL_THRESHOLD
    } else {
      // 面板与人物有重叠，算在区域内
      horizontalInZone = true
    }

    // 垂直方向检测：以人物中心为基准，上下各一半高度，冗余60px
    const verticalInZone =
      panelTop >= modelTop - PROXIMITY_CONFIG.VERTICAL_THRESHOLD &&
      panelTop <= modelBottom + PROXIMITY_CONFIG.VERTICAL_THRESHOLD

    return horizontalInZone && verticalInZone
  }

  /** 防抖定时器 */
  let modeSwitchDebounceTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 根据位置自动切换模式（带防抖）
   * @param panelLeft 面板左侧坐标
   * @param panelTop 面板上侧坐标
   * @param panelWidth 面板宽度
   */
  const autoSwitchMode = (panelLeft: number, panelTop: number, panelWidth: number) => {
    // 全局隐藏状态下不自动切换模式
    if (isCharacterHidden.value) return

    if (modeSwitchDebounceTimer) {
      clearTimeout(modeSwitchDebounceTimer)
    }

    modeSwitchDebounceTimer = setTimeout(() => {
      const inZone = checkInFollowZone(panelLeft, panelTop, panelWidth)
      isInFollowZone.value = inZone

      const targetMode: PanelMode = inZone ? 'follow' : 'independent'

      if (mode.value !== targetMode) {
        const el = panelRef.value
        if (el) {
          // 切换前记录当前位置
          if (mode.value === 'follow' && targetMode === 'independent') {
            const rect = el.getBoundingClientRect()
            screenX.value = rect.left
            screenY.value = rect.top
          }

          mode.value = targetMode
          isAnimating.value = true
          update()
          savePersist(
            panelType,
            mode.value,
            screenX.value,
            screenY.value,
            followOffsetX.value,
            followOffsetY.value,
          )

          if (animTimer) clearTimeout(animTimer)
          animTimer = setTimeout(() => {
            isAnimating.value = false
          }, 500)
        }
      }
    }, PROXIMITY_CONFIG.DEBOUNCE_DELAY)
  }

  /**
   * 拖拽过程中只检测是否在可跟随区域，用于状态指示
   * 不切换展开方向，避免定位干扰
   * @param panelLeft 面板左侧坐标
   * @param panelTop 面板上侧坐标
   * @param panelWidth 面板宽度
   */
  const checkZoneDuringDrag = (panelLeft: number, panelTop: number, panelWidth: number) => {
    const inZone = checkInFollowZone(panelLeft, panelTop, panelWidth)
    isInFollowZone.value = inZone
  }

  /** 计算跟随模式下的目标位置 */
  const calcFollow = () => {
    const m = modelPosition.value
    // Live2D的x就是人物中心点，直接使用
    const modelCenterX = m.x

    return {
      left:
        side === 'left'
          ? modelCenterX - GAP - PANEL_WIDTH - 200 + followOffsetX.value
          : modelCenterX + GAP + 100 + followOffsetX.value,
      top: m.y - m.height * 0.1 + verticalOffsetRef.value - 350 + followOffsetY.value,
    }
  }

  /**
   * 根据面板实际位置计算展开方向
   * 面板在人物左侧 -> 向左展开（展开时向左延展）
   * 面板在人物右侧 -> 向右展开（展开时向右延展）
   */
  const calcExpandDirection = (left: number): ExpandDirection => {
    const m = modelPosition.value
    const modelCenterX = m.x
    const panelCenterX = left + PANEL_WIDTH / 2

    // 面板中心在人物中心左侧则向左展开，否则向右展开
    return panelCenterX < modelCenterX ? 'left' : 'right'
  }

  /** 独立模式展开方向（根据屏幕空间） */
  const calcIndDir = (left: number): ExpandDirection =>
    window.innerWidth - left >= left ? 'right' : 'left'

  /** 直接操作DOM设置位置 */
  const apply = (left: number, top: number) => {
    const el = panelRef.value
    if (el) {
      el.style.left = `${left}px`
      el.style.top = `${top}px`
    }
  }

  /**
   * 根据展开方向调整定位方式
   * 向左展开（面板在人物左侧）：展开时向左延展，收起时右侧固定，使用right定位
   * 向右展开（面板在人物右侧）：展开时向右延展，收起时左侧固定，使用left定位
   * @param forceLeft 是否强制使用left定位（用于人物移动时，避免right定位导致的性能问题）
   */
  const applyPositionByDirection = (
    left: number,
    top: number,
    direction: ExpandDirection,
    forceLeft = false,
  ) => {
    const el = panelRef.value
    if (!el) return

    if (direction === 'left' && !forceLeft) {
      // 向左展开：收起时右侧固定，使用right定位（仅在展开/收起时使用）
      const right = window.innerWidth - left - PANEL_WIDTH
      el.style.left = 'auto'
      el.style.right = `${right}px`
      el.style.top = `${top}px`
    } else {
      // 向右展开：收起时左侧固定，使用left定位（人物移动时也使用left，避免性能问题）
      el.style.right = 'auto'
      el.style.left = `${left}px`
      el.style.top = `${top}px`
    }
  }

  /** 执行位置自检：只确保在屏幕内 */
  const selfCheckAndAvoid = (
    initialLeft: number,
    initialTop: number,
  ): { left: number; top: number } => {
    return { left: initialLeft, top: initialTop }
  }

  /** 更新面板位置 */
  const update = () => {
    const el = panelRef.value
    if (!el) return

    // v-show 控制面板显隐，这里只计算位置
    if (mode.value === 'follow') {
      const p = calcFollow()
      // 根据实际位置计算展开方向
      const direction = calcExpandDirection(p.left)
      expandDirection.value = direction

      // 执行位置自检和避让
      const adjusted = selfCheckAndAvoid(p.left, p.top)
      // 人物移动时强制使用left定位，避免right定位导致的性能问题
      applyPositionByDirection(adjusted.left, adjusted.top, direction, true)
    } else {
      const direction = calcIndDir(screenX.value)
      expandDirection.value = direction

      // 执行位置自检和避让
      const adjusted = selfCheckAndAvoid(screenX.value, screenY.value)
      applyPositionByDirection(adjusted.left, adjusted.top, direction)
    }
  }

  /** 拖拽状态 */
  let isDragging = false
  let dragStartX = 0
  let dragStartY = 0
  let dragStartLeft = 0
  let dragStartTop = 0

  /** mousemove - 拖拽中（实时计算位置并检测距离） */
  const onPointerMove = (e: MouseEvent) => {
    if (!isDragging) return
    const el = panelRef.value
    if (!el) return

    const dx = e.clientX - dragStartX
    const dy = e.clientY - dragStartY

    el.style.transition = 'none'

    // 拖拽过程中始终使用 left 定位，避免 right 定位带来的复杂性
    // 这样无论面板在人物哪一侧，拖拽逻辑都一致
    const currentLeft = dragStartLeft + dx
    const currentTop = dragStartTop + dy
    el.style.left = `${currentLeft}px`
    el.style.top = `${currentTop}px`
    // 清除 right 定位，避免冲突
    el.style.right = 'auto'

    // 只检测是否在可跟随区域，用于状态指示
    // 拖拽过程中不切换展开方向，避免定位干扰
    const rect = el.getBoundingClientRect()
    checkZoneDuringDrag(currentLeft, currentTop, rect.width)
  }

  /** mouseup - 拖拽结束 */
  const onPointerUp = () => {
    if (!isDragging) return
    isDragging = false
    document.removeEventListener('mousemove', onPointerMove)
    document.removeEventListener('mouseup', onPointerUp)

    const el = panelRef.value
    if (!el) return

    // 获取当前位置
    const rect = el.getBoundingClientRect()
    screenX.value = rect.left
    screenY.value = rect.top

    // 恢复transition
    el.style.transition = ''

    // 确保使用 left 定位
    el.style.right = 'auto'
    el.style.left = `${screenX.value}px`

    // 重新计算展开方向
    expandDirection.value = calcExpandDirection(screenX.value)

    // 确保在屏幕内
    const adjusted = selfCheckAndAvoid(screenX.value, screenY.value)
    screenX.value = adjusted.left
    screenY.value = adjusted.top

    // 根据位置自动切换模式（松手后才切换，避免拖拽过程中漂移）
    // 全局隐藏状态下不自动切换模式
    if (!isCharacterHidden.value) {
      const inZone = checkInFollowZone(screenX.value, screenY.value, rect.width)
      isInFollowZone.value = inZone
      const targetMode: PanelMode = inZone ? 'follow' : 'independent'

      // 模式切换时触发动画
      if (mode.value !== targetMode) {
        mode.value = targetMode
        isAnimating.value = true
        if (animTimer) clearTimeout(animTimer)
        animTimer = setTimeout(() => {
          isAnimating.value = false
        }, 500)
      }
    }

    // 跟随模式：计算偏移量
    if (mode.value === 'follow') {
      const m = modelPosition.value
      const defaultLeft = side === 'left' ? m.x - GAP - PANEL_WIDTH - 200 : m.x + GAP + 100
      const defaultTop = m.y - m.height * 0.1 + verticalOffsetRef.value - 350

      followOffsetX.value = screenX.value - defaultLeft
      followOffsetY.value = screenY.value - defaultTop
    }

    // 根据最终位置重新计算展开方向
    expandDirection.value = calcExpandDirection(screenX.value)

    // 应用最终位置
    applyPositionByDirection(screenX.value, screenY.value, expandDirection.value)

    savePersist(
      panelType,
      mode.value,
      screenX.value,
      screenY.value,
      followOffsetX.value,
      followOffsetY.value,
    )
  }

  /** mousedown - 拖拽开始 */
  const onPointerDown = (e: MouseEvent) => {
    if (e.button !== 0) return

    const t = e.target as HTMLElement
    if (!t.closest('.panel-header')) return
    if (t.closest('button, a, input, textarea, .task-item')) return

    e.preventDefault()

    const el = panelRef.value
    if (!el || !isModelReady()) return

    // 获取当前位置作为拖拽起点
    const rect = el.getBoundingClientRect()

    dragStartX = e.clientX
    dragStartY = e.clientY
    dragStartLeft = rect.left
    dragStartTop = rect.top
    isDragging = true

    document.addEventListener('mousemove', onPointerMove)
    document.addEventListener('mouseup', onPointerUp)
    e.stopPropagation()
  }

  /** 切换跟随/独立模式 */
  const toggleMode = () => {
    const el = panelRef.value
    if (!el) return

    // 跟随->独立：记住当前跟随位置
    if (mode.value === 'follow') {
      const rect = el.getBoundingClientRect()
      screenX.value = rect.left
      screenY.value = rect.top
    }
    // 独立->跟随：不需要额外操作，update会自动计算跟随位置

    mode.value = mode.value === 'follow' ? 'independent' : 'follow'
    isAnimating.value = true
    callbacks?.onModeChange?.(panelType, mode.value)
    update()
    savePersist(panelType, mode.value, screenX.value, screenY.value)

    if (animTimer) clearTimeout(animTimer)
    animTimer = setTimeout(() => {
      isAnimating.value = false
    }, 500)
  }

  /** 重置为跟随模式（飞行动画） */
  const resetToFollow = () => {
    // 清除存储的位置数据和偏移量
    screenX.value = 0
    screenY.value = 0
    followOffsetX.value = 0
    followOffsetY.value = 0

    isAnimating.value = true
    mode.value = 'follow'
    callbacks?.onModeChange?.(panelType, mode.value)
    update()
    savePersist(
      panelType,
      mode.value,
      screenX.value,
      screenY.value,
      followOffsetX.value,
      followOffsetY.value,
    )

    if (animTimer) clearTimeout(animTimer)
    animTimer = setTimeout(() => {
      isAnimating.value = false
    }, 500)
  }

  /** transitionend 事件处理 */
  const onTransitionEnd = (e: TransitionEvent) => {
    callbacks?.onTransitionEnd?.(panelType, e)
  }

  // 注册到全局管理器
  onMounted(() => {
    panelManager.register(panelType, panelRef)
    loadLockState()
    update()
    registerDrag()
    window.addEventListener('resize', onResize)
    panelRef.value?.addEventListener('transitionend', onTransitionEnd)
  })

  onUnmounted(() => {
    panelManager.unregister(panelType)
    unregisterDrag()
    window.removeEventListener('resize', onResize)
    panelRef.value?.removeEventListener('transitionend', onTransitionEnd)
    if (animTimer) clearTimeout(animTimer)
    if (rafId) cancelAnimationFrame(rafId)
    if (leaveTimer) clearTimeout(leaveTimer)
    if (enterTimer) clearTimeout(enterTimer)
    if (checkBoundsTimer) clearTimeout(checkBoundsTimer)
  })

  // 动画帧更新
  let rafId: number | null = null
  let pendingUpdate = false

  const scheduleUpdate = () => {
    // 拖拽过程中禁用自动更新，避免干扰拖拽
    if (isDragging || pendingUpdate) return
    pendingUpdate = true
    rafId = requestAnimationFrame(() => {
      pendingUpdate = false
      if (mode.value === 'follow') update()
    })
  }

  // 监听人物位置变化 - 使用 requestAnimationFrame 优化性能
  watch(
    () => modelPosition.value,
    () => {
      scheduleUpdate()
    },
    { deep: true, immediate: true },
  )

  // 监听垂直偏移变化
  watch(verticalOffsetRef, () => {
    scheduleUpdate()
  })

  // 监听窗口resize
  const onResize = () => update()

  // 注册拖拽
  const registerDrag = () => {
    const el = panelRef.value
    if (el) {
      el.addEventListener('mousedown', onPointerDown)
    }
  }

  const unregisterDrag = () => {
    const el = panelRef.value
    if (el) {
      el.removeEventListener('mousedown', onPointerDown)
    }
  }

  /** 鼠标进入处理 */
  const handleMouseEnter = () => {
    if (leaveTimer) {
      clearTimeout(leaveTimer)
      leaveTimer = null
    }
    enterTimer = setTimeout(() => {
      isHovered.value = true
      callbacks?.onHoverEnter?.(panelType)
    }, 100)
  }

  /** 鼠标离开处理 */
  const handleMouseLeave = () => {
    if (isLocked.value) return
    if (enterTimer) {
      clearTimeout(enterTimer)
      enterTimer = null
    }
    leaveTimer = setTimeout(() => {
      isHovered.value = false
      callbacks?.onHoverLeave?.(panelType)
    }, 300)
  }

  /** 切换锁定状态 */
  const handleToggleLock = () => {
    const newLocked = !isLocked.value
    isLocked.value = newLocked
    try {
      localStorage.setItem(`panel-lock-${panelType}`, JSON.stringify(isLocked.value))
    } catch {
      // ignore
    }
    if (newLocked) {
      callbacks?.onLock?.(panelType)
    } else {
      callbacks?.onUnlock?.(panelType)
    }
  }

  /** 加载锁定状态 */
  const loadLockState = () => {
    try {
      const saved = localStorage.getItem(`panel-lock-${panelType}`)
      if (saved) {
        isLocked.value = JSON.parse(saved)
      }
    } catch {
      // ignore
    }
  }

  /** 监听展开状态变化，展开时检查边界 */
  watch(
    () => isHovered.value || isLocked.value,
    (isExpanded) => {
      if (checkBoundsTimer) {
        clearTimeout(checkBoundsTimer)
        checkBoundsTimer = null
      }
      if (isExpanded) {
        checkBoundsTimer = setTimeout(() => {
          checkBounds()
          checkBoundsTimer = null
        }, 800)
      }
    },
  )

  /** 展开时检查边界 - 确保展开后的面板不会超出屏幕 */
  const checkBounds = () => {
    return
    const el = panelRef.value
    if (!el) return

    const rect = el.getBoundingClientRect()
    const MARGIN = 20

    let left = rect.left
    let top = rect.top

    // 使用实际渲染尺寸，而不是 scrollWidth/scrollHeight
    // 因为在动画过程中，scrollHeight 会返回完整内容高度，而不是当前渲染高度
    const currentWidth = rect.width
    const currentHeight = rect.height

    // 水平方向检查
    if (left + currentWidth > window.innerWidth - MARGIN) {
      left = window.innerWidth - MARGIN - currentWidth
    }
    if (left < MARGIN) {
      left = MARGIN
    }

    // 垂直方向检查
    if (top + currentHeight > window.innerHeight - MARGIN) {
      top = window.innerHeight - MARGIN - currentHeight
    }
    if (top < MARGIN) {
      top = MARGIN
    }

    // 应用调整后的位置
    if (left !== rect.left || top !== rect.top) {
      applyPositionByDirection(left, top, expandDirection.value)

      // 更新存储的位置
      if (mode.value === 'independent') {
        screenX.value = left
        screenY.value = top
        savePersist(panelType, mode.value, screenX.value, screenY.value)
      }
    }
  }

  // 清理防抖定时器
  onUnmounted(() => {
    if (modeSwitchDebounceTimer) {
      clearTimeout(modeSwitchDebounceTimer)
    }
  })

  return {
    mode,
    expandDirection,
    isAnimating,
    toggleMode,
    resetToFollow,
    checkBounds,
    isInFollowZone,
    isHovered,
    isLocked,
    handleMouseEnter,
    handleMouseLeave,
    handleToggleLock,
  }
}
