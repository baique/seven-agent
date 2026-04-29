import path from 'node:path'
import { terminalManagerSingleton } from './TerminalManager'

async function testExec() {
  console.log('=== 终端 Exec 测试 ===\n')

  try {
    // 测试1: 执行简单命令
    console.log('测试1: 执行 echo 命令')

    const result1 = await terminalManagerSingleton.exec(
      'test-1',
      'docker pull nginx ',
      path.resolve('.'),
    )
    console.log('会话ID:', result1.sessionId)
    console.log('日志文件:', result1.outputToFile)
    console.log('当前内容:', result1.currentContent?.substring(0, 200))
    console.log('✓ 测试1通过\n')

    console.log(terminalManagerSingleton.getSession('test-1')?.getLogScreen())

    await terminalManagerSingleton.exec('test-1', 'docker rmi nginx ', path.resolve('.'))

    // 清理
    terminalManagerSingleton.destroySession('test-1')

    process.exit(0)
  } catch (error) {
    console.error('测试失败:', error)
    process.exit(1)
  }
}

testExec()
