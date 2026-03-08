/**
 * 多机器人协同建造示例
 * 启动多个机器人进程同时建造一个建筑
 * 
 * 使用方法:
 *   node multiBuilder.js [host] [port] [botCount] [usernamePrefix] [flight]
 *   
 * 参数:
 *   host - 服务器地址 (默认: localhost)
 *   port - 服务器端口 (默认: 25565)
 *   botCount - 机器人数量 (默认: 20)
 *   usernamePrefix - 用户名前缀 (默认: builder)
 *   flight - 是否启用飞行 (默认: true)
 * 
 * 示例:
 *   node multiBuilder.js localhost 25565 20 builder true
 *   node multiBuilder.js localhost 25565 20 builder false  # 禁用飞行
 */

const { spawn } = require('child_process')
const path = require('path')

const host = process.argv[2] || 'localhost'
const port = process.argv[3] || 25565
const botCount = parseInt(process.argv[4]) || 20
const usernamePrefix = process.argv[5] || 'builder'
const useFlight = process.argv[6] !== 'false' // 默认启用飞行

console.log(`启动 ${botCount} 个机器人协同建造`)
console.log(`服务器: ${host}:${port}`)
console.log(`用户名前缀: ${usernamePrefix}`)
console.log(`飞行模式: ${useFlight}`)

// 存储所有子进程
const processes = new Map()
let statusInterval = null

// 启动单个机器人
function startBot (index) {
  const username = `${usernamePrefix}_${index}`
  
  const botProcess = spawn('node', [
    path.join(__dirname, 'workerBot.js'),
    host,
    port,
    username,
    index,
    '', // password
    useFlight.toString(),
    String(process.pid)
  ], {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })

  botProcess.on('error', (err) => {
    console.error(`[${username}] 进程错误:`, err.message)
  })

  botProcess.on('exit', (code, signal) => {
    console.log(`[${username}] 进程退出 (code: ${code}, signal: ${signal})`)
    const current = processes.get(index)
    if (current && current.process === botProcess) {
      current.exited = true
      current.exitCode = code
      current.signal = signal
    }
    if (!isShuttingDown && code !== 0 && code !== null) {
      console.log(`[${username}] 5秒后重启...`)
      setTimeout(() => {
        if (!isShuttingDown) startBot(index)
      }, 5000)
    }
  })

  processes.set(index, { process: botProcess, username, index, exited: false, exitCode: null, signal: null })
}

// 启动所有机器人
for (let i = 0; i < botCount; i++) {
  setTimeout(() => {
    console.log(`启动机器人 ${i + 1}/${botCount}: ${usernamePrefix}_${i}`)
    startBot(i)
  }, i * 1000)
}

// 处理退出信号
let isShuttingDown = false

function getAliveCount () {
  let aliveCount = 0
  for (const entry of processes.values()) {
    const child = entry.process
    const exited = entry.exited || child.exitCode !== null || child.signalCode !== null || child.killed
    if (!exited) aliveCount++
  }
  return aliveCount
}

function shutdown (signal = 'SIGTERM') {
  if (isShuttingDown) return
  isShuttingDown = true

  console.log('\n正在关闭所有机器人...')

  if (statusInterval) clearInterval(statusInterval)

  for (const entry of processes.values()) {
    const child = entry.process
    try {
      if (child.connected) child.send({ type: 'shutdown', signal })
    } catch (e) {}
  }

  setTimeout(() => {
    for (const entry of processes.values()) {
      const child = entry.process
      try {
        if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill('SIGTERM')
      } catch (e) {}
    }
  }, 200)

  setTimeout(() => {
    for (const entry of processes.values()) {
      const child = entry.process
      try {
        if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill('SIGKILL')
      } catch (e) {}
    }
    process.exit(0)
  }, 1500)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGHUP', () => shutdown('SIGHUP'))
process.on('beforeExit', () => shutdown('beforeExit'))
process.on('uncaughtException', (err) => {
  console.error('[multiBuilder] 未捕获异常:', err)
  shutdown('uncaughtException')
})
process.on('unhandledRejection', (err) => {
  console.error('[multiBuilder] 未处理拒绝:', err)
  shutdown('unhandledRejection')
})

// 定期输出状态
statusInterval = setInterval(() => {
  const aliveCount = getAliveCount()
  console.log(`\n[状态] 活跃机器人: ${aliveCount}/${botCount}`)
}, 60000)
