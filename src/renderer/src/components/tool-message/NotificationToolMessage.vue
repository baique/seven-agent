<script setup lang="ts">
import DefaultToolMessage from './DefaultToolMessage.vue'
import { useSocket } from '../../composables/useSocket'
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
const { reopenPopup } = useSocket()

/** 从 result 中解析弹窗 ID */
const popupId = computed(() => {
  const result = props.toolCall.result

  if (result) {
    try {
      const content = (result as string)?.split('\n')[0] || '{}'
      const parsedResult = JSON.parse(content) as Record<string, unknown>
      if (parsedResult.id && typeof parsedResult.id === 'string') {
        return parsedResult.id as string
      }
    } catch (error) {
      return undefined
    }
  }
  return undefined
})

/** 从 args 中解析弹窗参数 */
const popupParams = computed(() => {
  return props.toolCall.args
})

const handleReopen = () => {
  if (popupId.value) {
    reopenPopup(popupId.value, popupParams.value)
  }
}
</script>

<template>
  <DefaultToolMessage
    :tool-call="toolCall"
    :auto-expanded-id="autoExpandedId"
    @user-toggle="emit('userToggle')"
  >
    <template #action>
      <button
        v-if="popupId"
        class="tool-action-btn"
        title="重新打开弹窗"
        @click.stop="handleReopen"
      >
        打开
      </button>
    </template>
  </DefaultToolMessage>
</template>

<style scoped>
.tool-action-btn {
  background: none;
  border: 1px solid rgba(0, 212, 255, 0.3);
  color: #00d4ff;
  font-size: 11px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: all 0.2s;
  flex-shrink: 0;
  margin-right: 8px;
}

.tool-action-btn:hover {
  background: rgba(0, 212, 255, 0.1);
}
</style>
