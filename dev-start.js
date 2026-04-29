#!/usr/bin/env node

const { spawn } = require('child_process')

if (process.platform === 'win32') {
  try {
    require('child_process').execSync('chcp 65001', { stdio: 'ignore' })
  } catch (e) {}
}

/**
 * 解析命令行参数
 * 1. --KEY=VALUE 格式覆盖环境变量
 * 2. --ui 或 --server 模式参数
 * 3. --force 强制模式参数（传递给 server 子进程）
 * 用法: pnpm dev --EMBEDDING_ENABLED=0 --ui
 */
function parseArgs() {
  const envOverrides = {}
  const passthroughArgs = []
  let mode = null
  let force = false

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--')) {
      const [key, ...valueParts] = arg.slice(2).split('=')
      // 如果有等号，说明是环境变量覆盖
      if (key && valueParts.length > 0) {
        const value = valueParts.join('=')
        envOverrides[key] = value
        process.env[key] = value
      } else if (key === 'ui' || key === 'server') {
        // 模式参数
        mode = key
      } else if (key === 'force') {
        // --force 参数，传递给 server 子进程
        force = true
        process.env.SERVER_FORCE_MODE = 'true'
      } else if (key) {
        // 其他参数传递给 electron-vite
        passthroughArgs.push(arg)
      }
    }
  }

  if (Object.keys(envOverrides).length > 0) {
    console.log('\n[ENV 覆盖]')
    for (const [key, value] of Object.entries(envOverrides)) {
      const displayValue = key.includes('KEY') || key.includes('TOKEN') ? '***' : value
      console.log(`  ${key}=${displayValue}`)
    }
    console.log()
  }

  if (force) {
    console.log('\n[FORCE 模式] 启用强制模式，占用端口的进程将被强制结束\n')
  }

  return { passthroughArgs, mode, force }
}

const { passthroughArgs, mode, force } = parseArgs()

// 将模式设置为环境变量
if (mode) {
  process.env.APP_MODE = mode
}

const electronVite = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-vite', 'dev', ...passthroughArgs],
  {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      NODE_ENV: 'development',
    },
  },
)

electronVite.on('close', (code) => {
  process.exit(code)
})
