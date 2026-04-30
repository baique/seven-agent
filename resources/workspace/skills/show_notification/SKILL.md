---
name: open_window
description: 当需要输出报告、总结、通知、警告、任何长文本时，阅读本技能
---

使用 `open_window` 工具来完成

## 弹窗类型说明

### notification（简单通知）

- 默认类型
- 适合：一句话提醒、简短信息
- 默认尺寸：250x100像素
- 适合快速查看的信息

### report（报告展示）

- 适合：复杂内容、详细报告
- 默认尺寸：500x400像素
- 可以展示表格、代码、长文本

## 使用方式

### 1. 基本弹窗

直接使用即可，支持编写html/css/js代码，或者单纯的输出一段文本

```json
{
  "content": "这是一个简单的通知",
  "title": "通知",
  "popupType": "notification"
}
```

### 2. 任务总结

强烈建议使用html/css/js代码来实现任务总结，让内容更清晰美观

```json
{
  "content": "<h2>任务完成</h2><p>共处理了5个文件</p>",
  "title": "任务完成",
  "popupType": "notification"
}
```

### 3. 阶段性任务报告（使用刷新模式）

**重要：使用相同的 `id` 参数来刷新已有弹窗**

当你有一个长期任务，需要分阶段报告进度时，请使用相同的 `id` 参数。这样会：

- 激活已有弹窗
- 替换弹窗内容
- 刷新显示最新状态

**示例：文件处理任务**

第一步（开始处理）：

```json
{
  "content": "<h2>文件处理中</h2><p>正在处理第1/5个文件...</p>",
  "title": "处理进度",
  "popupType": "report",
  "id": "file-process-001"
}
```

第二步（更新进度）：

```json
{
  "content": "<h2>文件处理中</h2><p>已完成第1/5个文件</p><p>正在处理第2/5个文件...</p>",
  "title": "处理进度",
  "popupType": "report",
  "id": "file-process-001"
}
```

第三步（完成）：

```json
{
  "content": "<h2>文件处理完成</h2><p>成功处理5/5个文件</p><p>耗时：30秒</p>",
  "title": "处理完成",
  "popupType": "report",
  "id": "file-process-001"
}
```

**使用场景：**

- 长期任务进度报告
- 循环处理的阶段性反馈
- 需要持续更新的状态展示

### 4. 多任务报告（独立弹窗模式）

**重要：每个主题使用不同的 `id` 或不传 `id`**

当需要展示多个独立的主题报告时，每个报告使用独立的弹窗。这样用户可以：

- 同时查看多个报告
- 自由关闭不需要的报告
- 对比不同主题的内容

**示例：代码审查报告**

主弹窗（文件1审查）：

```json
{
  "content": "<h2>文件1审查</h2><p>发现3个问题...</p>",
  "title": "代码审查",
  "popupType": "report",
  "id": "review-file1"
}
```

主弹窗（文件2审查）：

```json
{
  "content": "<h2>文件2审查</h2><p>发现5个问题...</p>",
  "title": "代码审查",
  "popupType": "report",
  "id": "review-file2"
}
```

**使用场景：**

- 多文件/多模块的独立报告
- 需要对比查看的内容
- 长期任务的不同阶段（不需要刷新，只展示当前状态）

## HTML内容示例

### 表格

```html
<table style="width:100%;border-collapse:collapse">
  <tr>
    <th>项目</th>
    <th>状态</th>
  </tr>
  <tr>
    <td>文件1</td>
    <td>完成</td>
  </tr>
  <tr>
    <td>文件2</td>
    <td>进行中</td>
  </tr>
</table>
```

### 代码块

```html
<pre style="background:#f5f5f5;padding:10px;border-radius:4px">
<code>const result = await processFiles()</code>
</pre>
```

### 进度条

```html
<div style="background:#e0e0e0;border-radius:4px;height:20px">
  <div style="background:#4CAF50;width:75%;height:100%;border-radius:4px"></div>
</div>
<p>75% 完成</p>
```

### 列表

```html
<ul>
  <li>项目1：已完成</li>
  <li>项目2：进行中</li>
  <li>项目3：待开始</li>
</ul>
```

## 参数说明

- `content`: 弹窗内容，支持HTML标签
- `title`: 弹窗标题（可选）
- `popupType`: 弹窗类型，`notification` 或 `report`
- `width`: 宽度（像素，可选）
- `height`: 高度（像素，可选）
- `id`: 弹窗ID，用于刷新已有弹窗（可选）
- `duration`: 显示时长（毫秒，0表示不自动关闭）
- `continueProcessing`: true=继续让AI处理，false=直接结束

## 最佳实践

1. **阶段性任务**：使用相同的 `id` 刷新弹窗，保持用户关注同一个进度窗口
2. **独立报告**：使用不同的 `id` 或不传 `id`，让每个报告独立显示
3. **报告类型**：简短信息用 `notification`，复杂内容用 `report`
4. **视觉清晰**：使用HTML/CSS美化内容，让信息更易读
5. **及时更新**：阶段性任务及时刷新进度，让用户了解当前状态
