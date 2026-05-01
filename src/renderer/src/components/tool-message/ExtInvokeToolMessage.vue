<script setup lang="ts">
import DefaultToolMessage from './DefaultToolMessage.vue'
import { computed, onMounted } from 'vue'

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

/**
 * 解析 MCP 工具名称
 * 格式：mcp__服务器名__工具名
 */
const parsedToolInfo = computed(() => {
  const toolName = props.toolCall.args?.tool_name as string | undefined
  if (!toolName) {
    return { serverName: null, toolName: null, fullName: null }
  }

  const parts = toolName.split('__')
  if (parts.length >= 3 && parts[0] === 'mcp') {
    return {
      serverName: parts[1],
      toolName: parts.slice(2).join('__'),
      fullName: toolName,
    }
  }

  return { serverName: null, toolName: toolName, fullName: toolName }
})
</script>

<template>
  <DefaultToolMessage
    :tool-call="toolCall"
    :auto-expanded-id="autoExpandedId"
    @user-toggle="emit('userToggle')"
  >
    <template #name="{ name }">
      <div class="ext-invoke-tool-name">
        <span class="mcp-badge">MCP</span>
        <template v-if="parsedToolInfo.serverName">
          <span class="server-name" :title="parsedToolInfo.serverName">{{
            parsedToolInfo.serverName
          }}</span>
          <span class="separator">/</span>
          <span class="tool-name" :title="parsedToolInfo.toolName">{{
            parsedToolInfo.toolName
          }}</span>
        </template>
        <template v-else-if="parsedToolInfo.toolName">
          <span class="tool-name" :title="parsedToolInfo.toolName">{{
            parsedToolInfo.toolName
          }}</span>
        </template>
        <template v-else>
          <span class="tool-name" :title="name">{{ name }}</span>
        </template>
      </div>
    </template>
  </DefaultToolMessage>
</template>

<style scoped>
.ext-invoke-tool-name {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.mcp-badge {
  background: linear-gradient(135deg, rgba(0, 212, 255, 0.2) 0%, rgba(0, 150, 200, 0.3) 100%);
  color: #00d4ff;
  font-size: 9px;
  font-weight: 600;
  padding: 1px 4px;
  border-radius: 3px;
  border: 1px solid rgba(0, 212, 255, 0.4);
  flex-shrink: 0;
}

.server-name {
  color: #a0d8ef;
  font-size: 11px;
  font-weight: 500;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;
}

.separator {
  color: rgba(0, 212, 255, 0.6);
  font-size: 11px;
  flex-shrink: 0;
}

.tool-name {
  color: #00ffff;
  font-size: 11px;
  font-weight: 500;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;
}
</style>
