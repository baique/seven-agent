<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { bindToggleMouseEvent } from '../util'
import { useSocket } from '../composables/useSocket'
import { eventBus, Events } from '../eventBus'
import { usePanelPosition } from '../composables/usePanelPosition'

interface Task {
  id: string
  description: string
  status: 'pending' | 'done'
  deadline?: string
}

interface Props {
  visible?: boolean
  chatVisible?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  visible: true,
  chatVisible: false,
})

const { getTaskList } = useSocket()
const taskCount = ref(0)
const taskList = ref<Task[]>([])
const currentTask = ref<Task | null>(null)
const loading = ref(false)
const panelRef = ref<HTMLElement | null>(null)

/** 垂直偏移 - 根据chatVisible动态计算（响应式） */
const verticalOffset = computed(() => (props.chatVisible ? 610 : 390))

/** 使用新的面板定位系统（modelPosition通过inject获取） */
const {
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
} = usePanelPosition('task', panelRef, verticalOffset)

onUnmounted(() => {
  offSocketReady()
  offTaskUpdated()
})

const loadTasks = async () => {
  loading.value = true
  try {
    const result = await getTaskList()
    if (result?.success) {
      taskCount.value = result.tasks?.length || 0
      taskList.value = result.tasks || []
      currentTask.value = result.currentTask || null
    }
  } catch (e) {
    console.error('[TaskPanel] 加载任务失败:', e)
  } finally {
    loading.value = false
  }
}

const offSocketReady = eventBus.on(Events.SOCKET_READY, () => {
  loadTasks()
})

const offTaskUpdated = eventBus.on(Events.TASK_UPDATED, () => {
  loadTasks()
})

onMounted(() => {
  if (panelRef.value) {
    bindToggleMouseEvent(panelRef.value)
  }
})

/** 是否启用呼吸感动效（当前面板未锁定时） */
const isBreathingEnabled = computed(() => {
  return !isLocked.value
})

defineExpose({
  loadTasks,
  resetToFollow,
  get mode() {
    return mode.value
  },
})
</script>

<template>
  <div
    ref="panelRef"
    class="task-panel"
    :class="[
      `pos-${expandDirection}`, // 使用动态展开方向
      {
        expanded: isHovered || isLocked,
        locked: isLocked,
        breathing: isBreathingEnabled,
        'panel-following': mode === 'follow',
        'panel-independent': mode === 'independent',
        'panel-animating': isAnimating,
      },
    ]"
    @mouseenter="handleMouseEnter"
    @mouseleave="handleMouseLeave"
    @contextmenu.prevent="handleToggleLock"
  >
    <div class="panel-corner tl"></div>
    <div class="panel-corner tr"></div>
    <div class="panel-corner bl"></div>
    <div class="panel-corner br"></div>

    <div class="scan-line"></div>

    <div class="panel-header">
      <div class="header-left">
        <div class="header-icon">
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path
              d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"
            />
          </svg>
        </div>
        <span class="header-title">任务</span>
        <!-- 独立模式图标 - 断开的链接 -->
        <svg
          v-if="mode === 'independent'"
          class="mode-icon-indicator"
          viewBox="0 0 24 24"
          fill="currentColor"
          title="独立模式"
        >
          <path
            d="M17 7h-4v2h4c1.65 0 3 1.35 3 3s-1.35 3-3 3h-4v2h4c2.76 0 5-2.24 5-5s-2.24-5-5-5zm-6 8H7c-1.65 0-3-1.35-3-3s1.35-3 3-3h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-2zm-3-4h8v2H8z"
          />
        </svg>
      </div>
      <div class="header-right">
        <!-- 锁定标识 -->
        <svg v-if="isLocked" class="lock-icon" viewBox="0 0 24 24" fill="currentColor">
          <path
            d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"
          />
        </svg>
        <div v-if="taskCount > 0" class="corner-badge">
          {{ taskCount }}
        </div>
      </div>
    </div>

    <div class="panel-summary">
      <div class="status-text">
        <template v-if="taskCount === 0">
          <span class="status-dot idle"></span>
          无任务
        </template>
        <template v-else-if="currentTask">
          <span class="status-dot active"></span>
          {{ currentTask.id }}
        </template>
        <template v-else>
          <span class="status-dot idle"></span>
          {{ taskCount }} 个任务
        </template>
      </div>
    </div>

    <div class="detail-content">
      <div v-if="currentTask" class="current-task">
        <div class="task-label">进行中</div>
        <div class="task-name">{{ currentTask.id }}</div>
      </div>
      <div v-if="taskList.length > 0" class="task-list">
        <div v-for="task in taskList" :key="task.id" class="task-item">
          <span class="task-status-dot" :class="task.status"></span>
          <span class="task-item-name">{{ task.id }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-panel {
  position: fixed;
  pointer-events: auto;
  width: 170px;
  max-height: 40px;
  background: linear-gradient(135deg, rgba(10, 10, 26, 0.85) 0%, rgba(20, 20, 45, 0.9) 100%);
  border: 1px solid rgba(255, 136, 0, 0.35);
  border-radius: 8px;
  padding: 12px;
  transition:
    max-height 0.4s ease,
    width 0.2s ease 0.6s,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    left 0.5s ease,
    top 0.5s ease;
  box-shadow:
    0 4px 20px rgba(0, 0, 0, 0.4),
    0 0 30px rgba(255, 136, 0, 0.08),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  overflow: hidden;
  z-index: 101;
}

.task-panel:hover {
  z-index: 201;
}

.task-panel.breathing:not(.expanded) {
  animation: breathe 3s ease-in-out infinite;
  animation-delay: 1s;
}

.task-panel.expanded {
  width: 300px;
  max-height: 280px;
  border-color: rgba(255, 136, 0, 0.6);
  box-shadow:
    0 6px 30px rgba(0, 0, 0, 0.5),
    0 0 40px rgba(255, 136, 0, 0.15);
  transition:
    width 0.2s ease,
    max-height 0.4s ease 0.4s,
    border-color 0.2s ease,
    box-shadow 0.2s ease,
    left 0.5s ease,
    top 0.5s ease;
}

@keyframes breathe {
  0%,
  100% {
    transform: translateY(0);
  }
  25% {
    transform: translateY(-4px);
  }
  50% {
    transform: translateY(-6px);
  }
  75% {
    transform: translateY(-4px);
  }
}

.panel-corner {
  position: absolute;
  width: 12px;
  height: 12px;
  border-color: #ff8800;
  border-style: solid;
  opacity: 0.6;
  transition: opacity 0.3s ease;
}

.task-panel.expanded .panel-corner {
  opacity: 0.8;
}

.panel-corner.tl {
  top: 3px;
  left: 3px;
  border-width: 2px 0 0 2px;
  border-radius: 3px 0 0 0;
}

.panel-corner.tr {
  top: 3px;
  right: 3px;
  border-width: 2px 2px 0 0;
  border-radius: 0 3px 0 0;
}

.panel-corner.bl {
  bottom: 3px;
  left: 3px;
  border-width: 0 0 2px 2px;
  border-radius: 0 0 0 3px;
}

.panel-corner.br {
  bottom: 3px;
  right: 3px;
  border-width: 0 2px 2px 0;
  border-radius: 0 0 3px 0;
}

.scan-line {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, rgba(255, 136, 0, 0.5), transparent);
  animation: scan 5s linear infinite;
  opacity: 0.3;
  animation-delay: -1s;
}

@keyframes scan {
  0% {
    top: 0;
  }
  100% {
    top: 100%;
  }
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0;
  transition: margin-bottom 0.3s ease;
  position: relative;
  top: -2px;
  user-select: none;
  cursor: move;
}

.task-panel.expanded .panel-header {
  margin-bottom: 10px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

/** 独立模式图标 */
.mode-icon-indicator {
  width: 12px;
  height: 12px;
  color: #ff8800;
  filter: drop-shadow(0 0 3px rgba(255, 136, 0, 0.5));
  flex-shrink: 0;
}

.header-icon {
  width: 18px;
  height: 18px;
  color: #ff8800;
  filter: drop-shadow(0 0 5px rgba(255, 136, 0, 0.5));
  flex-shrink: 0;
}

.header-icon svg {
  width: 100%;
  height: 100%;
}

.header-title {
  font-size: 13px;
  font-weight: 600;
  color: #ff8800;
  text-shadow: 0 0 10px rgba(255, 136, 0, 0.3);
  letter-spacing: 1px;
}

.lock-icon {
  width: 14px;
  height: 14px;
  color: #ff8800;
  filter: drop-shadow(0 0 4px rgba(255, 136, 0, 0.8));
  flex-shrink: 0;
}

.corner-badge {
  width: 18px;
  height: 18px;
  line-height: 18px;
  background: rgba(255, 136, 0, 0.25);
  border: 1px solid rgba(255, 136, 0, 0.5);
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
  color: #ff8800;
  text-align: center;
  box-shadow: 0 0 10px rgba(255, 136, 0, 0.3);
  flex-shrink: 0;
  transform: translateY(-1px);
}

.panel-summary {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition:
    max-height 0.3s ease,
    opacity 0.3s ease,
    margin-bottom 0.3s ease;
  margin-bottom: 0;
}

.task-panel.expanded .panel-summary {
  max-height: 50px;
  opacity: 1;
  margin-bottom: 10px;
}

.status-text {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.6);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.status-dot.idle {
  background: #666;
}

.status-dot.active {
  background: #ff8800;
  box-shadow: 0 0 8px #ff8800;
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.6;
  }
}

.detail-content {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  transition:
    max-height 0.3s ease,
    opacity 0.3s ease;
}

.task-panel.expanded .detail-content {
  max-height: 200px;
  opacity: 1;
}

.current-task {
  background: rgba(255, 136, 0, 0.1);
  border: 1px solid rgba(255, 136, 0, 0.3);
  border-radius: 6px;
  padding: 8px;
  margin-bottom: 10px;
}

.task-label {
  font-size: 10px;
  color: #ff8800;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 1px;
}

.task-name {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.9);
  font-weight: 500;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.task-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 4px;
  font-size: 11px;
}

.task-status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
}

.task-status-dot.pending {
  background: #666;
}

.task-status-dot.pending {
  background: #ff8800;
  box-shadow: 0 0 5px #ff8800;
}

.task-status-dot.done {
  background: #00ff88;
  box-shadow: 0 0 5px #00ff88;
}

.task-item-name {
  color: rgba(255, 255, 255, 0.7);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
