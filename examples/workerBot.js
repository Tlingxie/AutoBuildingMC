/**
 * 单个机器人工作进程
 * 由 multiBuilder.js 启动
 */

const path = require('path')
const fs = require('fs').promises
const { builder, Build } = require('mineflayer-builder')
const { Schematic } = require('prismarine-schematic')
const { pathfinder } = require('mineflayer-pathfinder')
const mineflayer = require('mineflayer')

const host = process.argv[2] || 'localhost'
const port = parseInt(process.argv[3]) || 25565
const username = process.argv[4] || 'builder_0'
const botIndex = parseInt(process.argv[5]) || 0
const useFlight = process.argv[7] !== 'false' // 默认启用飞行
const parentPid = parseInt(process.argv[8], 10) || process.ppid

console.log(`[${username}] 连接到 ${host}:${port}, 飞行模式: ${useFlight}`)

const bot = mineflayer.createBot({
  host,
  port,
  username,
  password: process.argv[6] || undefined
})

bot.loadPlugin(pathfinder)
bot.loadPlugin(builder)

function wait (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

let exiting = false
let parentWatchdog = null

function isParentAlive () {
  if (!parentPid || parentPid <= 1) return false
  try {
    process.kill(parentPid, 0)
    return true
  } catch (e) {
    return false
  }
}

function startParentWatchdog () {
  if (parentWatchdog) clearInterval(parentWatchdog)
  parentWatchdog = setInterval(() => {
    if (!isParentAlive()) {
      console.log(`[${username}] 检测到主进程已退出，子进程即将关闭`)
      quickExit('parent-lost')
    }
  }, 2000)
}

// 锁文件路径
const LOCK_DIR = path.join(__dirname, '../.build_locks')
const BUILD_INFO_FILE = path.join(LOCK_DIR, 'build_info.json')

// 尝试获取建造信息
async function getBuildInfo () {
  try {
    const data = await fs.readFile(BUILD_INFO_FILE, 'utf8')
    return JSON.parse(data)
  } catch (e) {
    return null
  }
}

// 设置建造信息
async function setBuildInfo (info) {
  await fs.mkdir(LOCK_DIR, { recursive: true })
  await fs.writeFile(BUILD_INFO_FILE, JSON.stringify(info))
}

// 等待建造信息
async function waitForBuildInfo () {
  // 等待第一个机器人创建建造信息
  for (let i = 0; i < 60; i++) {
    const info = await getBuildInfo()
    if (info) return info
    await wait(1000)
  }
  return null
}

bot.once('spawn', async () => {
  console.log(`[${username}] 已进入服务器`)

  // 启用飞行模式
  if (useFlight) {
    try {
      // 尝试切换到创造模式
      bot.chat('/gamemode creative')
      await wait(1000)
      console.log(`[${username}] 飞行模式已启用`)
    } catch (e) {
      console.log(`[${username}] 无法启用飞行: ${e.message}`)
    }
  }

  // 等待稳定
  await wait(1000)

  const schematicPath = path.resolve(__dirname, '../schematics/smallhouse1.schem')
  const schematic = await Schematic.read(await fs.readFile(schematicPath), bot.version)

  // 第一个机器人初始化建造
  if (botIndex === 0) {
    const at = bot.entity.position.floored()
    console.log(`[${username}] 初始化建造位置:`, at)
    
    await setBuildInfo({
      startPosition: { x: at.x, y: at.y, z: at.z },
      schematicPath,
      startTime: Date.now()
    })

    // 等待其他机器人连接
    console.log(`[${username}] 等待其他机器人连接...`)
    await wait(10000)
  }

  // 获取建造位置
  const buildInfo = botIndex === 0 ? await getBuildInfo() : await waitForBuildInfo()
  
  if (!buildInfo) {
    console.log(`[${username}] 无法获取建造信息，退出`)
    return
  }

  const at = new (require('vec3').Vec3)(
    buildInfo.startPosition.x,
    buildInfo.startPosition.y,
    buildInfo.startPosition.z
  )

  console.log(`[${username}] 开始建造于:`, at)

  // 创建 Build 对象，传入机器人ID
  const build = new Build(schematic, bot.world, at, username)

  try {
    await bot.builder.build(build, username, useFlight)
    console.log(`[${username}] 建造完成！`)
  } catch (e) {
    console.error(`[${username}] 建造错误:`, e)
  }
})

// 错误处理
bot.on('error', (err) => {
  console.error(`[${username}] 机器人错误:`, err.message)
})

// 清理函数
function cleanupLocks () {
  try {
    const lockDir = path.join(__dirname, '../.build_locks')
    const fs = require('fs')

    if (parentWatchdog) {
      clearInterval(parentWatchdog)
      parentWatchdog = null
    }

    // 清理任务锁
    if (fs.existsSync(lockDir)) {
      const files = fs.readdirSync(lockDir)
      for (const file of files) {
        const filePath = path.join(lockDir, file)
        try {
          if (file.endsWith('.lock')) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
            if (data.robotId === username) {
              fs.unlinkSync(filePath)
            }
          } else if (file === 'positions') {
            const posDir = filePath
            if (fs.existsSync(posDir)) {
              const posFiles = fs.readdirSync(posDir)
              for (const pf of posFiles) {
                if (pf === `${username}.pos`) {
                  fs.unlinkSync(path.join(posDir, pf))
                }
              }
            }
          }
        } catch (e) {}
      }
    }
  } catch (e) {}
}

bot.on('end', (reason) => {
  console.log(`[${username}] 断开连接:`, reason)
  cleanupLocks()
  if (!exiting) process.exit(0)
})

function quickExit (reason = 'shutdown') {
  if (exiting) return
  exiting = true
  console.log(`[${username}] 正在退出: ${reason}`)
  cleanupLocks()
  try { bot.quit(reason) } catch (e) {}
  setTimeout(() => process.exit(0), 300)
}

process.on('SIGTERM', () => quickExit('SIGTERM'))
process.on('SIGINT', () => quickExit('SIGINT'))
process.on('SIGHUP', () => quickExit('SIGHUP'))
process.on('disconnect', () => quickExit('ipc-disconnect'))
process.on('message', (message) => {
  if (message && message.type === 'shutdown') quickExit(message.signal || 'ipc-shutdown')
})
process.on('beforeExit', () => quickExit('beforeExit'))

startParentWatchdog()
