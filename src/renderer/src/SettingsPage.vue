<template>
  <div class="settings-container">
    <!-- 标题栏 -->
    <div class="title-bar" @mousedown="startDrag">
      <div class="title">
        <span class="title-icon">⚙️</span>
        <span>配置中心</span>
      </div>
      <div class="window-controls">
        <button class="btn-minimize" title="最小化" @click="minimizeWindow">−</button>
        <button class="btn-close" title="关闭" @click="closeWindow">×</button>
      </div>
    </div>

    <!-- 主内容区 -->
    <div class="main-content">
      <!-- 左侧导航 -->
      <div class="sidebar">
        <div
          v-for="tab in tabs"
          :key="tab.id"
          class="nav-item"
          :class="{ active: currentTab === tab.id }"
          @click="currentTab = tab.id"
        >
          <span class="nav-icon">{{ tab.icon }}</span>
          <span class="nav-label">{{ tab.label }}</span>
        </div>
      </div>

      <!-- 右侧内容 -->
      <div class="content">
        <!-- 工具审查配置 -->
        <div v-if="currentTab === 'review'" class="tab-panel">
          <div class="panel-header">
            <h2>🛡️ 工具审查配置</h2>
            <p class="panel-desc">配置哪些工具不需要审查（白名单），白名单内的工具会自动执行</p>
          </div>

          <!-- 内置工具 -->
          <div class="section">
            <div class="section-header">
              <h3>内置工具</h3>
              <span class="badge">{{ Object.values(toolCategories).flat().length }}</span>
            </div>
            <div class="tool-grid">
              <div v-for="(tools, category) in toolCategories" :key="category" class="tool-group">
                <div class="group-header" @click="toggleGroup(category)">
                  <span class="group-arrow" :class="{ expanded: expandedGroups.has(category) }"
                    >▶</span
                  >
                  <span class="group-name">{{ category }}</span>
                  <span class="group-count">{{ tools.length }}</span>
                </div>
                <div v-show="expandedGroups.has(category)" class="group-tools">
                  <label
                    v-for="tool in tools"
                    :key="tool"
                    class="tool-checkbox"
                    :class="{ checked: whitelist.includes(tool) }"
                  >
                    <input
                      type="checkbox"
                      :checked="whitelist.includes(tool)"
                      @change="toggleWhitelist(tool)"
                    />
                    <span class="checkmark"></span>
                    <span class="tool-name">{{ tool }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- MCP 工具 -->
          <div v-if="mcpToolsByServer.length > 0" class="section">
            <div class="section-header">
              <h3>MCP 工具</h3>
              <span class="badge">{{ mcpTools.length }}</span>
            </div>
            <div class="tool-grid">
              <div v-for="server in mcpToolsByServer" :key="server.name" class="tool-group">
                <div class="group-header" @click="toggleGroup('mcp_' + server.name)">
                  <span
                    class="group-arrow"
                    :class="{ expanded: expandedGroups.has('mcp_' + server.name) }"
                    >▶</span
                  >
                  <span class="group-name">{{ server.name }}</span>
                  <span class="group-count">{{ server.tools.length }}</span>
                </div>
                <div v-show="expandedGroups.has('mcp_' + server.name)" class="group-tools">
                  <label
                    v-for="tool in server.tools"
                    :key="tool.fullName"
                    class="tool-checkbox"
                    :class="{ checked: whitelist.includes(tool.fullName) }"
                  >
                    <input
                      type="checkbox"
                      :checked="whitelist.includes(tool.fullName)"
                      @change="toggleWhitelist(tool.fullName)"
                    />
                    <span class="checkmark"></span>
                    <span class="tool-name">{{ tool.shortName }}</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- 保存按钮 -->
          <div v-if="hasWhitelistChanges" class="floating-actions">
            <button class="btn-save" @click="saveWhitelist"><span>💾</span> 保存更改</button>
            <button class="btn-reset" @click="resetWhitelist"><span>↩️</span> 重置</button>
          </div>
        </div>

        <!-- 工具截断配置 -->
        <div v-if="currentTab === 'truncation'" class="tab-panel">
          <div class="panel-header">
            <h2>✂️ 工具截断配置</h2>
            <p class="panel-desc">配置工具响应的截断策略，控制工具输出内容的长度</p>
          </div>

          <!-- 默认策略 -->
          <div class="section">
            <div class="section-header">
              <h3>默认策略</h3>
            </div>
            <div class="default-strategy">
              <div class="strategy-field">
                <label>最大字符数</label>
                <input
                  v-model.number="truncationConfig.defaultMaxChars"
                  type="number"
                  min="1000"
                  max="50000"
                  step="1000"
                  @change="saveTruncationImmediate"
                />
              </div>
              <div class="strategy-field">
                <label>截断模式</label>
                <select v-model="truncationConfig.defaultMode" @change="saveTruncationImmediate">
                  <option value="head">📄 头部（保留前面）</option>
                  <option value="tail">📄 尾部（保留后面）</option>
                  <option value="structure">📋 结构（保留首行）</option>
                  <option value="summary">📋 摘要（头尾各保留一部分）</option>
                </select>
              </div>
            </div>
          </div>

          <!-- 特定工具策略 -->
          <div class="section">
            <div class="section-header">
              <h3>特定工具策略</h3>
              <span class="badge">{{ Object.keys(truncationConfig.strategies).length }}</span>
            </div>

            <!-- 已配置的策略列表 -->
            <div class="strategy-list">
              <div
                v-for="(strategy, toolName) in truncationConfig.strategies"
                :key="toolName"
                class="strategy-card"
              >
                <div class="strategy-info">
                  <span class="strategy-tool">{{ toolName }}</span>
                  <button class="btn-delete" @click="removeStrategyAndSave(toolName)">🗑️</button>
                </div>
                <div class="strategy-config">
                  <div class="config-item">
                    <label>字符数</label>
                    <input
                      v-model.number="strategy.maxChars"
                      type="number"
                      min="1000"
                      max="50000"
                      step="1000"
                      :placeholder="String(truncationConfig.defaultMaxChars)"
                      @change="saveTruncationImmediate"
                    />
                  </div>
                  <div class="config-item">
                    <label>模式</label>
                    <select v-model="strategy.mode" @change="saveTruncationImmediate">
                      <option value="">
                        默认 ({{ getModeLabel(truncationConfig.defaultMode) }})
                      </option>
                      <option value="head">头部</option>
                      <option value="tail">尾部</option>
                      <option value="structure">结构</option>
                      <option value="summary">摘要</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>

            <!-- 添加新策略 -->
            <div class="add-strategy-card">
              <h4>添加特定工具策略</h4>
              <div class="add-strategy-form">
                <select v-model="newStrategyTool" class="tool-select">
                  <option value="">选择工具...</option>
                  <optgroup
                    v-for="(tools, category) in allToolsByCategory"
                    :key="category"
                    :label="category"
                  >
                    <option v-for="tool in tools" :key="tool" :value="tool">{{ tool }}</option>
                  </optgroup>
                </select>
                <select v-model="newStrategyMode" class="mode-select">
                  <option value="">使用默认</option>
                  <option value="head">头部</option>
                  <option value="tail">尾部</option>
                  <option value="structure">结构</option>
                  <option value="summary">摘要</option>
                </select>
                <input
                  v-model.number="newStrategyMaxChars"
                  type="number"
                  placeholder="字符数"
                  min="1000"
                  max="50000"
                  step="1000"
                  class="chars-input"
                />
                <button class="btn-add" :disabled="!newStrategyTool" @click="addStrategyAndSave">
                  <span>➕</span> 添加
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- MCP 服务器管理 -->
        <div v-if="currentTab === 'mcp'" class="tab-panel">
          <div class="panel-header">
            <h2>🔌 MCP 服务器管理</h2>
            <p class="panel-desc">查看已配置的 MCP 服务器，刷新工具缓存</p>
          </div>

          <div class="section">
            <div class="mcp-actions">
              <button class="btn-refresh" :disabled="isRefreshing" @click="refreshAllMCP">
                <span v-if="isRefreshing">🔄</span>
                <span v-else>🔄</span>
                {{ isRefreshing ? '刷新中...' : '刷新所有服务器' }}
              </button>
            </div>

            <div class="mcp-grid">
              <div v-for="server in mcpServers" :key="server.name" class="server-card">
                <div class="server-header">
                  <div class="server-info">
                    <span class="server-name">{{ server.name }}</span>
                    <span class="server-type" :class="server.transport">{{
                      server.transport
                    }}</span>
                  </div>
                  <button
                    class="btn-refresh-small"
                    :disabled="isRefreshing"
                    @click="refreshMCP(server.name)"
                  >
                    🔄
                  </button>
                </div>
                <div class="server-config">
                  <code v-if="server.transport === 'stdio'">
                    {{ server.stdio?.command }} {{ server.stdio?.args?.join(' ') }}
                  </code>
                  <code v-else>
                    {{ server.http?.baseUrl }}
                  </code>
                </div>
              </div>
            </div>

            <div v-if="mcpServers.length === 0" class="empty-state">
              <span class="empty-icon">📭</span>
              <p>未配置 MCP 服务器</p>
            </div>
          </div>

          <!-- 刷新结果 -->
          <div v-if="refreshResults.length > 0" class="section">
            <div class="section-header">
              <h3>刷新结果</h3>
            </div>
            <div class="refresh-list">
              <div
                v-for="(result, index) in refreshResults.slice(0, 10)"
                :key="index"
                class="refresh-item"
                :class="result.success ? 'success' : 'error'"
              >
                <span class="refresh-server">{{ result.serverName }}</span>
                <span class="refresh-status">{{ result.success ? '✓' : '✗' }}</span>
                <span class="refresh-message">{{ result.message }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'

// 标签页
const tabs = [
  { id: 'review', label: '工具审查', icon: '🛡️' },
  { id: 'truncation', label: '工具截断', icon: '✂️' },
  { id: 'mcp', label: 'MCP服务器', icon: '🔌' },
]

const currentTab = ref('review')

// 窗口控制
const minimizeWindow = () => {
  window.api?.minimize?.()
}

const closeWindow = () => {
  window.api?.close?.()
}

const startDrag = () => {
  window.api?.ipcRenderer?.send('window-start-drag')
}

// 工具分类
const toolCategories = {
  系统信息: ['get_system_info', 'get_current_time', 'get_clipboard', 'set_clipboard'],
  文件操作: ['read_file', 'read_line', 'list_directory', 'get_file_info', 'file_exists', 'grep'],
  文件修改: [
    'write_file',
    'edit_file',
    'delete_file',
    'move_file',
    'copy_file',
    'create_directory',
  ],
  终端执行: ['terminal', 'python_repl'],
  记忆系统: ['memory_search', 'memory_deep_search', 'update_memory'],
  任务管理: ['create_tasks', 'update_task', 'list_tasks', 'delete_task', 'add_note'],
  提醒功能: ['schedule_reminder', 'query_reminders', 'delete_reminder'],
  扩展工具: ['ext_search', 'ext_list', 'ext_invoke'],
  其他: ['show_notification', 'update_mood_values', 'list_subagents'],
}

// 展开/折叠状态
const expandedGroups = ref(new Set<string>())
const toggleGroup = (group: string) => {
  if (expandedGroups.value.has(group)) {
    expandedGroups.value.delete(group)
  } else {
    expandedGroups.value.add(group)
  }
}

// MCP 工具按服务器分组
const mcpToolsByServer = computed(() => {
  const groups: Record<string, { name: string; tools: { fullName: string; shortName: string }[] }> =
    {}

  for (const tool of mcpTools.value) {
    const match = tool.match(/^mcp__(.+?)__(.+)$/)
    if (match) {
      const serverName = match[1]
      const shortName = match[2]
      if (!groups[serverName]) {
        groups[serverName] = { name: serverName, tools: [] }
      }
      groups[serverName].tools.push({ fullName: tool, shortName })
    }
  }

  return Object.values(groups)
})

// 所有工具按分类（用于截断配置）
const allToolsByCategory = computed(() => {
  const result: Record<string, string[]> = { ...toolCategories }

  // 添加 MCP 工具
  for (const server of mcpToolsByServer.value) {
    result[`MCP: ${server.name}`] = server.tools.map((t) => t.fullName)
  }

  return result
})

// 白名单配置
const whitelist = ref<string[]>([])
const originalWhitelist = ref<string[]>([])

const hasWhitelistChanges = computed(() => {
  if (whitelist.value.length !== originalWhitelist.value.length) return true
  return (
    whitelist.value.some((tool) => !originalWhitelist.value.includes(tool)) ||
    originalWhitelist.value.some((tool) => !whitelist.value.includes(tool))
  )
})

const toggleWhitelist = (tool: string) => {
  const index = whitelist.value.indexOf(tool)
  if (index > -1) {
    whitelist.value.splice(index, 1)
  } else {
    whitelist.value.push(tool)
  }
}

const saveWhitelist = async () => {
  try {
    const plainWhitelist = JSON.parse(JSON.stringify(whitelist.value))
    const result = await window.api.settings.saveWhitelist(plainWhitelist)
    if (result.success) {
      originalWhitelist.value = [...whitelist.value]
      alert('保存成功')
    } else {
      alert('保存失败: ' + result.error)
    }
  } catch (error) {
    alert('保存失败')
  }
}

const resetWhitelist = () => {
  whitelist.value = [...originalWhitelist.value]
}

// 截断配置
const truncationConfig = reactive({
  defaultMaxChars: 10240,
  defaultMaxLines: 2000,
  defaultMode: 'head' as const,
  strategies: {} as Record<string, { maxChars?: number; mode?: string }>,
})

const originalTruncation = reactive({
  defaultMaxChars: 10240,
  defaultMaxLines: 2000,
  defaultMode: 'head' as const,
  strategies: {},
})

const newStrategyTool = ref('')
const newStrategyMode = ref('')
const newStrategyMaxChars = ref<number | undefined>(undefined)

const getModeLabel = (mode: string) => {
  const labels: Record<string, string> = {
    head: '头部',
    tail: '尾部',
    structure: '结构',
    summary: '摘要',
  }
  return labels[mode] || mode
}

const addStrategy = () => {
  if (!newStrategyTool.value) return
  truncationConfig.strategies[newStrategyTool.value] = {
    maxChars: newStrategyMaxChars.value || undefined,
    mode: newStrategyMode.value || undefined,
  }
}

const addStrategyAndSave = async () => {
  addStrategy()
  await saveTruncationImmediate()
  newStrategyTool.value = ''
  newStrategyMaxChars.value = undefined
  newStrategyMode.value = ''
}

const removeStrategyAndSave = async (toolName: string) => {
  delete truncationConfig.strategies[toolName]
  await saveTruncationImmediate()
}

const saveTruncationImmediate = async () => {
  try {
    const plainConfig = JSON.parse(
      JSON.stringify({
        defaultMaxChars: truncationConfig.defaultMaxChars,
        defaultMaxLines: truncationConfig.defaultMaxLines,
        defaultMode: truncationConfig.defaultMode,
        strategies: truncationConfig.strategies,
      }),
    )
    const result = await window.api.settings.saveTruncation(plainConfig)
    if (result.success) {
      Object.assign(originalTruncation, truncationConfig)
    }
  } catch (error) {
    console.error('[SettingsPage] saveTruncation error:', error)
  }
}

// MCP 服务器
interface MCPServer {
  name: string
  transport: 'stdio' | 'http'
  stdio?: { command: string; args?: string[] }
  http?: { baseUrl: string }
}

const mcpServers = ref<MCPServer[]>([])
const mcpTools = ref<string[]>([])
const isRefreshing = ref(false)
const refreshResults = ref<Array<{ serverName: string; success: boolean; message: string }>>([])

const loadMCPServers = async () => {
  try {
    const result = await window.api.settings.getMCPServers()
    if (result.success) {
      mcpServers.value = result.servers
    }
  } catch (error) {
    console.error('加载 MCP 服务器失败:', error)
  }
}

const loadMCPTools = async () => {
  try {
    const result = await window.api.settings.getMCPTools()
    if (result.success) {
      mcpTools.value = result.tools || []
    }
  } catch (error) {
    console.error('加载 MCP 工具失败:', error)
  }
}

const refreshMCP = async (serverName: string) => {
  isRefreshing.value = true
  try {
    const result = await window.api.settings.refreshMCP(serverName)
    refreshResults.value.unshift({
      serverName,
      success: result.success,
      message: result.message,
    })
  } catch (error) {
    refreshResults.value.unshift({
      serverName,
      success: false,
      message: '刷新失败',
    })
  } finally {
    isRefreshing.value = false
  }
}

const refreshAllMCP = async () => {
  isRefreshing.value = true
  refreshResults.value = []
  try {
    const result = await window.api.settings.refreshAllMCP()
    if (result.results) {
      for (const r of result.results) {
        refreshResults.value.push({
          serverName: r.serverName || 'unknown',
          success: r.success,
          message: r.message,
        })
      }
    }
  } catch (error) {
    refreshResults.value.push({
      serverName: 'all',
      success: false,
      message: '刷新失败',
    })
  } finally {
    isRefreshing.value = false
  }
}

// 加载配置
const loadSettings = async () => {
  try {
    const result = await window.api.settings.getConfig()
    if (result.success) {
      whitelist.value = [...result.config.toolReview.whitelist]
      originalWhitelist.value = [...result.config.toolReview.whitelist]
      Object.assign(truncationConfig, result.config.toolTruncation)
      Object.assign(originalTruncation, result.config.toolTruncation)
    }
  } catch (error) {
    console.error('加载配置失败:', error)
  }
}

onMounted(() => {
  loadSettings()
  loadMCPServers()
  loadMCPTools()
})
</script>

<style scoped>
/* 基础样式 */
* {
  scrollbar-width: thin;
  scrollbar-color: rgba(100, 120, 255, 0.3) transparent;
}

::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: rgba(100, 120, 255, 0.3);
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: rgba(100, 120, 255, 0.5);
}

.settings-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: linear-gradient(135deg, #0a0a0f 0%, #12121a 50%, #0d0d14 100%);
  color: #e0e0ff;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  overflow: hidden;
}

/* 标题栏 */
.title-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  background: rgba(20, 20, 35, 0.8);
  border-bottom: 1px solid rgba(100, 120, 255, 0.1);
  backdrop-filter: blur(10px);
  -webkit-app-region: drag;
}

.title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 600;
  color: #fff;
}

.title-icon {
  font-size: 20px;
}

.window-controls {
  display: flex;
  gap: 8px;
  -webkit-app-region: no-drag;
}

.window-controls button {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.05);
  color: #a0a0c0;
  font-size: 18px;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.window-controls button:hover {
  background: rgba(100, 120, 255, 0.2);
  color: #fff;
}

.btn-close:hover {
  background: rgba(255, 80, 80, 0.3) !important;
  color: #ff8080 !important;
}

/* 主内容 */
.main-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

/* 侧边栏 */
.sidebar {
  width: 200px;
  background: rgba(15, 15, 25, 0.6);
  padding: 16px 0;
  border-right: 1px solid rgba(100, 120, 255, 0.08);
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  margin: 0 8px;
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s;
  color: #8080a0;
}

.nav-item:hover {
  background: rgba(100, 120, 255, 0.08);
  color: #b0b0d0;
}

.nav-item.active {
  background: linear-gradient(135deg, rgba(100, 120, 255, 0.2) 0%, rgba(80, 100, 220, 0.15) 100%);
  color: #6b8cff;
  box-shadow: 0 2px 8px rgba(100, 120, 255, 0.15);
}

.nav-icon {
  font-size: 20px;
}

.nav-label {
  font-size: 14px;
  font-weight: 500;
}

/* 内容区 */
.content {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}

.tab-panel {
  max-width: 900px;
}

.panel-header {
  margin-bottom: 24px;
  padding-bottom: 16px;
  border-bottom: 1px solid rgba(100, 120, 255, 0.1);
}

.panel-header h2 {
  font-size: 24px;
  font-weight: 600;
  color: #fff;
  margin-bottom: 8px;
}

.panel-desc {
  color: #8080a0;
  font-size: 14px;
}

/* 区块 */
.section {
  background: rgba(20, 20, 35, 0.4);
  border-radius: 16px;
  padding: 20px;
  margin-bottom: 20px;
  border: 1px solid rgba(100, 120, 255, 0.08);
}

.section-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.section-header h3 {
  font-size: 16px;
  font-weight: 600;
  color: #e0e0ff;
}

.badge {
  padding: 2px 10px;
  background: rgba(100, 120, 255, 0.15);
  border-radius: 12px;
  font-size: 12px;
  color: #6b8cff;
  font-weight: 500;
}

/* 工具网格 */
.tool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}

.tool-group {
  background: rgba(25, 25, 40, 0.6);
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid rgba(100, 120, 255, 0.05);
}

.group-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  cursor: pointer;
  transition: background 0.2s;
  user-select: none;
}

.group-header:hover {
  background: rgba(100, 120, 255, 0.05);
}

.group-arrow {
  font-size: 10px;
  color: #606080;
  transition: transform 0.2s;
}

.group-arrow.expanded {
  transform: rotate(90deg);
}

.group-name {
  flex: 1;
  font-weight: 500;
  color: #c0c0e0;
  font-size: 14px;
}

.group-count {
  padding: 2px 8px;
  background: rgba(100, 120, 255, 0.1);
  border-radius: 10px;
  font-size: 11px;
  color: #8080a0;
}

.group-tools {
  padding: 8px 16px 16px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
}

.tool-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  font-size: 13px;
}

.tool-checkbox:hover {
  background: rgba(100, 120, 255, 0.08);
}

.tool-checkbox.checked {
  background: rgba(100, 120, 255, 0.15);
}

.tool-checkbox input {
  display: none;
}

.checkmark {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(100, 120, 255, 0.3);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  font-size: 10px;
}

.tool-checkbox.checked .checkmark {
  background: linear-gradient(135deg, #6b8cff 0%, #5a7aee 100%);
  border-color: #6b8cff;
}

.tool-checkbox.checked .checkmark::after {
  content: '✓';
  color: #fff;
}

.tool-name {
  color: #a0a0c0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-checkbox.checked .tool-name {
  color: #6b8cff;
}

/* 浮动操作按钮 */
.floating-actions {
  position: fixed;
  bottom: 24px;
  right: 32px;
  display: flex;
  gap: 12px;
}

.floating-actions button {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  border: none;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.btn-save {
  background: linear-gradient(135deg, #6b8cff 0%, #5a7aee 100%);
  color: #fff;
}

.btn-save:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(100, 120, 255, 0.4);
}

.btn-reset {
  background: rgba(255, 255, 255, 0.1);
  color: #e0e0ff;
}

.btn-reset:hover {
  background: rgba(255, 255, 255, 0.15);
}

/* 默认策略 */
.default-strategy {
  display: flex;
  gap: 24px;
  flex-wrap: wrap;
}

.strategy-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.strategy-field label {
  font-size: 13px;
  color: #8080a0;
}

.strategy-field input,
.strategy-field select {
  padding: 10px 14px;
  background: rgba(25, 25, 40, 0.6);
  border: 1px solid rgba(100, 120, 255, 0.15);
  border-radius: 10px;
  color: #e0e0ff;
  font-size: 14px;
  min-width: 180px;
}

.strategy-field input:focus,
.strategy-field select:focus {
  outline: none;
  border-color: rgba(100, 120, 255, 0.4);
}

/* 策略列表 */
.strategy-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 20px;
}

.strategy-card {
  background: rgba(25, 25, 40, 0.6);
  border-radius: 12px;
  padding: 16px;
  border: 1px solid rgba(100, 120, 255, 0.08);
}

.strategy-info {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.strategy-tool {
  font-weight: 500;
  color: #e0e0ff;
  font-size: 14px;
}

.btn-delete {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  padding: 4px;
  opacity: 0.6;
  transition: opacity 0.2s;
}

.btn-delete:hover {
  opacity: 1;
}

.strategy-config {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}

.config-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.config-item label {
  font-size: 12px;
  color: #606080;
}

.config-item input,
.config-item select {
  padding: 8px 12px;
  background: rgba(30, 30, 45, 0.6);
  border: 1px solid rgba(100, 120, 255, 0.15);
  border-radius: 8px;
  color: #e0e0ff;
  font-size: 13px;
  width: 140px;
}

/* 添加策略卡片 */
.add-strategy-card {
  background: rgba(25, 25, 40, 0.4);
  border-radius: 12px;
  padding: 20px;
  border: 2px dashed rgba(100, 120, 255, 0.2);
}

.add-strategy-card h4 {
  font-size: 14px;
  color: #8080a0;
  margin-bottom: 16px;
}

.add-strategy-form {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: flex-end;
}

.add-strategy-form select,
.add-strategy-form input {
  padding: 10px 14px;
  background: rgba(25, 25, 40, 0.6);
  border: 1px solid rgba(100, 120, 255, 0.15);
  border-radius: 10px;
  color: #e0e0ff;
  font-size: 14px;
}

.tool-select {
  flex: 1;
  min-width: 200px;
}

.mode-select {
  width: 140px;
}

.chars-input {
  width: 120px;
}

.btn-add {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 20px;
  background: linear-gradient(135deg, #6b8cff 0%, #5a7aee 100%);
  border: none;
  border-radius: 10px;
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-add:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(100, 120, 255, 0.3);
}

.btn-add:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* MCP 服务器 */
.mcp-actions {
  margin-bottom: 20px;
}

.btn-refresh {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  background: linear-gradient(135deg, rgba(100, 120, 255, 0.2) 0%, rgba(80, 100, 220, 0.15) 100%);
  border: 1px solid rgba(100, 120, 255, 0.2);
  border-radius: 12px;
  color: #6b8cff;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-refresh:hover:not(:disabled) {
  background: linear-gradient(135deg, rgba(100, 120, 255, 0.3) 0%, rgba(80, 100, 220, 0.25) 100%);
}

.btn-refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.mcp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}

.server-card {
  background: rgba(25, 25, 40, 0.6);
  border-radius: 12px;
  padding: 16px;
  border: 1px solid rgba(100, 120, 255, 0.08);
}

.server-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.server-info {
  display: flex;
  align-items: center;
  gap: 10px;
}

.server-name {
  font-weight: 600;
  color: #e0e0ff;
  font-size: 15px;
}

.server-type {
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  text-transform: uppercase;
  font-weight: 500;
}

.server-type.stdio {
  background: rgba(100, 200, 100, 0.15);
  color: #70d070;
}

.server-type.http {
  background: rgba(100, 150, 255, 0.15);
  color: #70a0ff;
}

.btn-refresh-small {
  background: rgba(100, 120, 255, 0.1);
  border: none;
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}

.btn-refresh-small:hover:not(:disabled) {
  background: rgba(100, 120, 255, 0.2);
}

.server-config {
  padding: 10px 12px;
  background: rgba(15, 15, 25, 0.6);
  border-radius: 8px;
}

.server-config code {
  font-size: 12px;
  color: #606080;
  word-break: break-all;
}

.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: #505060;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
  display: block;
}

/* 刷新结果 */
.refresh-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.refresh-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 13px;
}

.refresh-item.success {
  background: rgba(100, 200, 100, 0.1);
}

.refresh-item.error {
  background: rgba(200, 100, 100, 0.1);
}

.refresh-server {
  font-weight: 500;
  min-width: 100px;
}

.refresh-item.success .refresh-server {
  color: #70d070;
}

.refresh-item.error .refresh-server {
  color: #ff8080;
}

.refresh-status {
  font-size: 14px;
}

.refresh-message {
  color: #8080a0;
  flex: 1;
}
</style>
