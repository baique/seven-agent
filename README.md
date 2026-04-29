# Seven Agent

基于 Electron + Vue + TypeScript 的 AI 桌面助手。

## 技术栈

- **前端**: Vue 3 + TypeScript + Tailwind CSS + Ant Design X Vue
- **后端**: Node.js + TypeScript (独立服务进程)
- **桌面**: Electron
- **AI**: LangChain + LangGraph + MCP
- **终端**: node-pty + xterm
- **语音**: Edge TTS / MiniMax TTS / Dolphin TTS

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 仅启动服务端
pnpm server
```

## 项目结构

```
src/
  main/           # Electron 主进程
  preload/        # 预加载脚本
  renderer/       # Vue 前端
  server/         # AI 服务端
    terminal/     # 终端模块
    tools/        # 工具系统
    memory/       # 记忆系统
    tts/          # 语音合成
resources/        # 静态资源
  model/          # Live2D 模型（不提交）
models/           # LLM 模型配置（不提交）
skills/           # AI 技能定义
```

## 配置

复制 `.env.example` 为 `.env`，填入你的 API Key：

```bash
cp .env.example .env
```

## License

MIT
