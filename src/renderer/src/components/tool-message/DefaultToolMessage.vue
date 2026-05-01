<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  toolCall: {
    id: string
    name: string
    args?: Record<string, unknown>
    result?: unknown
    status?: string
    _expanded?: boolean
  }
  /** 自动展开的消息ID */
  autoExpandedId?: string | null
}>()

const emit = defineEmits<{
  /** 用户手动切换展开状态时触发 */
  (e: 'userToggle'): void
}>()

/** 是否展开，优先使用自动展开逻辑 */
const isExpanded = computed({
  get: () => {
    // 如果是最后一条消息且用户未设置过，自动展开
    if (props.autoExpandedId === props.toolCall.id) {
      return true
    }
    return props.toolCall._expanded ?? false
  },
  set: (value: boolean) => {
    emit('userToggle')
    props.toolCall._expanded = value
  },
})

/** 是否为加载中状态 */
const isLoading = computed(() => props.toolCall.status === 'loading')

const toggleExpand = () => {
  // loading 状态下禁止展开
  // if (isLoading.value) return
  isExpanded.value = !isExpanded.value
}

/** 检查是否有有效参数（非空对象） */
const hasArgs = computed(() => {
  const args = props.toolCall.args
  if (!args) return false
  if (typeof args !== 'object') return false
  return Object.keys(args).length > 0
})
</script>

<template>
  <div class="tool-call" :class="[isExpanded ? 'expanded' : '', isLoading ? 'loading' : '']">
    <div class="tool-header" :class="{ 'cursor-pointer': !isLoading }" @click="toggleExpand">
      <!-- loading 状态显示旋转动画 -->
      <template v-if="isLoading">
        <svg class="tool-icon loading-icon" viewBox="0 0 24 24">
          <circle
            cx="12"
            cy="12"
            r="10"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-dasharray="31.42"
            stroke-dashoffset="10"
          />
        </svg>
      </template>
      <template v-else>
        <svg class="tool-icon" viewBox="0 0 24 24">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
      </template>
      <!-- 工具名称插槽，提供默认实现 -->
      <div class="tool-name">
        <slot name="name">
          <span :title="toolCall.name">{{ toolCall.name }}</span>
        </slot>
      </div>
      <slot name="action" />
      <!-- 非 loading 状态显示展开箭头 -->
      <svg :class="['tool-toggle', isExpanded ? 'expanded' : '']" viewBox="0 0 24 24">
        <path d="M6 9l6 6 6-6" />
      </svg>
    </div>
    <div v-if="isExpanded" class="tool-body">
      <div v-if="hasArgs" class="tool-section">
        <div class="tool-section-title">参数</div>
        <pre class="tool-params">{{ JSON.stringify(toolCall.args, null, 2) }}</pre>
      </div>
      <div v-if="toolCall.result && !isLoading" class="tool-section">
        <div class="tool-section-title">结果</div>
        <pre class="tool-result">{{
          typeof toolCall.result === 'string'
            ? toolCall.result
            : JSON.stringify(toolCall.result, null, 2)
        }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tool-call {
  background: rgba(0, 40, 60, 0.6);
  border: 1px solid rgba(0, 212, 255, 0.3);
  border-radius: 6px;
  overflow: hidden;
  transition: all 0.3s ease;
}

.tool-call:hover {
  border-color: rgba(0, 212, 255, 0.6);
  box-shadow: 0 0 20px rgba(0, 212, 255, 0.15);
}

.tool-header {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  background: rgba(0, 212, 255, 0.05);
  transition: background 0.2s;
}

.tool-header:hover {
  background: rgba(0, 212, 255, 0.1);
}

.tool-icon {
  width: 18px;
  height: 18px;
  margin-right: 8px;
  fill: #00d4ff;
}

.tool-name {
  color: #00ffff;
  font-weight: 500;
  font-size: 12px;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-toggle {
  width: 16px;
  height: 16px;
  fill: #00d4ff;
  transition: transform 0.3s;
  margin-left: auto;
}

.tool-toggle.expanded {
  transform: rotate(180deg);
}

/** loading 状态样式 */
.tool-call.loading {
  border-color: rgba(0, 212, 255, 0.2);
  background: rgba(0, 40, 60, 0.4);
}

.tool-call.loading .tool-header {
  cursor: default;
}

.tool-call.loading .tool-header:hover {
  background: rgba(0, 212, 255, 0.05);
}

.tool-icon.loading-icon {
  animation: rotate 1s linear infinite;
  color: #00d4ff;
}

@keyframes rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.cursor-pointer {
  cursor: pointer;
}

.tool-body {
  max-height: 600px;
  overflow: hidden;
  transition: max-height 0.4s ease;
  display: none;
}

.tool-call.expanded .tool-body {
  max-height: 600px;
  display: block;
}

.tool-section {
  padding: 10px 12px;
  border-top: 1px solid rgba(0, 212, 255, 0.15);
}

.tool-section-title {
  color: #00d4ff;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 1px;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  font-weight: 600;
}

.tool-section-title::before {
  content: '';
  display: inline-block;
  width: 2px;
  height: 10px;
  background: linear-gradient(180deg, #00d4ff, #0088aa);
  margin-right: 6px;
  border-radius: 2px;
  box-shadow: 0 0 6px rgba(0, 212, 255, 0.6);
}

.tool-params,
.tool-result {
  background: linear-gradient(135deg, rgba(0, 10, 25, 0.9) 0%, rgba(0, 20, 40, 0.85) 100%);
  border-radius: 4px;
  padding: 8px 10px;
  font-family: 'Consolas', 'Monaco', monospace;
  font-size: 11px;
  color: #a0d8ef;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 120px;
  overflow-y: auto;
  position: relative;
  border: 1px solid rgba(0, 212, 255, 0.15);
  margin: 0;
}

.tool-result {
  color: #7fffb0;
  border: 1px solid rgba(0, 212, 255, 0.2);
}

.tool-params::-webkit-scrollbar,
.tool-result::-webkit-scrollbar {
  width: 3px;
  height: 3px;
}

.tool-params::-webkit-scrollbar-track,
.tool-result::-webkit-scrollbar-track {
  background: rgba(0, 212, 255, 0.05);
  border-radius: 2px;
}

.tool-params::-webkit-scrollbar-thumb,
.tool-result::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, #0088aa 0%, #00d4ff 50%, #0088aa 100%);
  border-radius: 2px;
  box-shadow:
    0 0 4px rgba(0, 212, 255, 0.6),
    inset 0 0 2px rgba(0, 212, 255, 0.3);
}
</style>
