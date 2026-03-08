const { goals, Movements } = require('mineflayer-pathfinder')
const Build = require('./lib/Build')

const interactable = require('./lib/interactable.json')

function wait (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

// 带超时的 Promise 包装
function withTimeout (promise, ms, errorMsg = 'Operation timed out') {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorMsg)), ms))
  ])
}

function hashString (value) {
  let hash = 0
  for (const ch of value) {
    hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0
  }
  return Math.abs(hash)
}

function inject (bot) {
  if (!bot.pathfinder) {
    throw new Error('pathfinder must be loaded before builder')
  }

  const mcData = require('minecraft-data')(bot.version)
  const Item = require('prismarine-item')(bot.version)
  const Vec3 = require('vec3').Vec3

  const movements = new Movements(bot, mcData)
  movements.canDig = true
  movements.digCost = 5
  movements.maxDropDown = 256
  movements.canPlace = true
  
  // 启用飞行模式
  movements.allow1by1towers = true // 允许搭高
  movements.canFly = true // 启用飞行
  movements.flySpeed = 0.5 // 飞行速度
  movements.maxJump = 256 // 最大跳跃高度（飞行时）
  
  bot.pathfinder.searchRadius = 50

  bot.builder = {}

  // 启用飞行
  async function enableFlight () {
    try {
      // 尝试切换到创造模式
      if (bot.game.gameMode !== 'creative' && bot.game.gameMode !== 'spectator') {
        bot.chat('/gamemode creative')
        await wait(500)
      }
      console.log(`[${bot.username}] Flight mode ready`)
    } catch (e) {
      console.log(`[${bot.username}] Could not enable flight: ${e.message}`)
    }
  }

  const FLIGHT_NEIGHBORS = []
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue
        const offset = new Vec3(dx, dy, dz)
        FLIGHT_NEIGHBORS.push({ offset, cost: Math.sqrt(dx * dx + dy * dy + dz * dz) })
      }
    }
  }

  function getFlightCellKey (pos) {
    return pos.x + ',' + pos.y + ',' + pos.z
  }

  function toFlightCell (pos) {
    return new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z))
  }

  function toFlightCenter (cell) {
    return cell.offset(0.5, 0.5, 0.5)
  }

  function getFlightDirection (from, to) {
    return new Vec3(
      Math.sign(to.x - from.x),
      Math.sign(to.y - from.y),
      Math.sign(to.z - from.z)
    )
  }

  function sameFlightDirection (left, right) {
    return left && right && left.x === right.x && left.y === right.y && left.z === right.z
  }

  function isFlightBlockPassable (block) {
    return !block || block.name === 'air' || block.boundingBox === 'empty' || (Array.isArray(block.shapes) && block.shapes.length === 0)
  }

  function getFlightObstacleKeys () {
    const robotId = bot.builder.currentRobotId || bot.username
    const obstacles = new Set()

    for (const other of getOtherBotPositions(robotId)) {
      const base = new Vec3(Math.floor(other.x), Math.floor(other.y), Math.floor(other.z))
      obstacles.add(getFlightCellKey(base))
      obstacles.add(getFlightCellKey(base.offset(0, 1, 0)))
    }

    return obstacles
  }

  function isSameFlightCell (left, right) {
    return left.x === right.x && left.y === right.y && left.z === right.z
  }

  function isFlightCellPassable (cell, startCell, obstacleKeys) {
    if (isSameFlightCell(cell, startCell)) return true

    const key = getFlightCellKey(cell)
    if (obstacleKeys.has(key)) return false

    return isFlightBlockPassable(bot.blockAt(cell)) && isFlightBlockPassable(bot.blockAt(cell.offset(0, 1, 0)))
  }

  function canTraverseFlightStep (fromCell, toCell, startCell, obstacleKeys) {
    if (!isFlightCellPassable(toCell, startCell, obstacleKeys)) return false

    const dx = toCell.x - fromCell.x
    const dy = toCell.y - fromCell.y
    const dz = toCell.z - fromCell.z
    const checks = []

    if (dx !== 0) checks.push(fromCell.offset(dx, 0, 0))
    if (dy !== 0) checks.push(fromCell.offset(0, dy, 0))
    if (dz !== 0) checks.push(fromCell.offset(0, 0, dz))
    if (dx !== 0 && dy !== 0) checks.push(fromCell.offset(dx, dy, 0))
    if (dx !== 0 && dz !== 0) checks.push(fromCell.offset(dx, 0, dz))
    if (dy !== 0 && dz !== 0) checks.push(fromCell.offset(0, dy, dz))

    for (const check of checks) {
      if (!isFlightCellPassable(check, startCell, obstacleKeys)) return false
    }

    return true
  }

  function getFlightPointBetween (from, to, ratio) {
    return new Vec3(
      from.x + (to.x - from.x) * ratio,
      from.y + (to.y - from.y) * ratio,
      from.z + (to.z - from.z) * ratio
    )
  }

  function hasFlightLineOfSight (fromCell, toCell, startCell, obstacleKeys) {
    if (isSameFlightCell(fromCell, toCell)) return true

    const from = toFlightCenter(fromCell)
    const to = toFlightCenter(toCell)
    const distance = from.distanceTo(to)
    const steps = Math.max(1, Math.ceil(distance / 0.35))
    let previousCell = fromCell

    for (let step = 1; step <= steps; step++) {
      const point = getFlightPointBetween(from, to, step / steps)
      const cell = toFlightCell(point)
      if (isSameFlightCell(cell, previousCell)) continue
      if (!canTraverseFlightStep(previousCell, cell, startCell, obstacleKeys)) return false
      previousCell = cell
    }

    return true
  }

  function smoothFlightCells (cells, startCell, obstacleKeys) {
    if (cells.length <= 2) return cells

    const smoothed = [cells[0]]
    let index = 0

    while (index < cells.length - 1) {
      let nextIndex = cells.length - 1
      while (nextIndex > index + 1 && !hasFlightLineOfSight(cells[index], cells[nextIndex], startCell, obstacleKeys)) {
        nextIndex--
      }
      smoothed.push(cells[nextIndex])
      index = nextIndex
    }

    return smoothed
  }

  function getFlightBounds (startCell, targetCell, extraMargin = 0) {
    const dx = Math.abs(targetCell.x - startCell.x)
    const dy = Math.abs(targetCell.y - startCell.y)
    const dz = Math.abs(targetCell.z - startCell.z)
    const span = dx + dy + dz
    const horizontalMargin = Math.min(16, Math.max(6, Math.ceil(span / 4))) + extraMargin
    const verticalMargin = Math.min(10, Math.max(4, Math.ceil(dy / 2) + 3)) + extraMargin

    return {
      minX: Math.min(startCell.x, targetCell.x) - horizontalMargin,
      maxX: Math.max(startCell.x, targetCell.x) + horizontalMargin,
      minY: Math.min(startCell.y, targetCell.y) - verticalMargin,
      maxY: Math.max(startCell.y, targetCell.y) + verticalMargin,
      minZ: Math.min(startCell.z, targetCell.z) - horizontalMargin,
      maxZ: Math.max(startCell.z, targetCell.z) + horizontalMargin
    }
  }

  function isWithinFlightBounds (cell, bounds) {
    return cell.x >= bounds.minX && cell.x <= bounds.maxX &&
      cell.y >= bounds.minY && cell.y <= bounds.maxY &&
      cell.z >= bounds.minZ && cell.z <= bounds.maxZ
  }

  function getFlightHeuristic (from, to) {
    const dx = from.x - to.x
    const dy = from.y - to.y
    const dz = from.z - to.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  function compressFlightCells (cells) {
    if (cells.length <= 2) return cells

    const compressed = [cells[0]]
    let previousDirection = null

    for (let index = 1; index < cells.length; index++) {
      const from = cells[index - 1]
      const current = cells[index]
      const next = cells[index + 1]
      const direction = getFlightDirection(from, current)

      if (next && sameFlightDirection(previousDirection, direction)) continue

      compressed.push(current)
      previousDirection = direction
    }

    return compressed
  }

  function reconstructFlightPath (cameFrom, nodes, currentKey, target, startCell, obstacleKeys) {
    const cells = []
    let key = currentKey

    while (key) {
      cells.push(nodes.get(key).pos)
      key = cameFrom.get(key)
    }

    cells.reverse()

    const smoothed = smoothFlightCells(cells, startCell, obstacleKeys)
    const compressed = compressFlightCells(smoothed)
    const waypoints = compressed.slice(1).map(cell => toFlightCenter(cell))
    if (waypoints.length === 0) return [target.clone()]
    waypoints[waypoints.length - 1] = target.clone()
    return waypoints
  }

  function findFlightPath (startPos, targetPos, extraMargin = 0, maxVisited = 6000) {
    const startCell = toFlightCell(startPos)
    const targetCell = toFlightCell(targetPos)

    if (startCell.x === targetCell.x && startCell.y === targetCell.y && startCell.z === targetCell.z) {
      return [targetPos.clone()]
    }

    const obstacleKeys = getFlightObstacleKeys()
    const bounds = getFlightBounds(startCell, targetCell, extraMargin)
    const startKey = getFlightCellKey(startCell)
    const targetKey = getFlightCellKey(targetCell)

    const openKeys = [startKey]
    const openSet = new Set([startKey])
    const closedSet = new Set()
    const cameFrom = new Map()
    const gScore = new Map([[startKey, 0]])
    const fScore = new Map([[startKey, getFlightHeuristic(startCell, targetCell)]])
    const nodes = new Map([[startKey, { pos: startCell }]])

    let visited = 0

    while (openKeys.length > 0 && visited < maxVisited) {
      let bestIndex = 0
      let bestKey = openKeys[0]
      let bestScore = fScore.get(bestKey) ?? Number.POSITIVE_INFINITY

      for (let index = 1; index < openKeys.length; index++) {
        const candidateKey = openKeys[index]
        const candidateScore = fScore.get(candidateKey) ?? Number.POSITIVE_INFINITY
        if (candidateScore < bestScore) {
          bestIndex = index
          bestKey = candidateKey
          bestScore = candidateScore
        }
      }

      openKeys.splice(bestIndex, 1)
      openSet.delete(bestKey)
      visited++

      if (bestKey === targetKey) {
        return reconstructFlightPath(cameFrom, nodes, bestKey, targetPos, startCell, obstacleKeys)
      }

      closedSet.add(bestKey)
      const current = nodes.get(bestKey).pos
      const baseCost = gScore.get(bestKey) ?? Number.POSITIVE_INFINITY

      for (const neighborStep of FLIGHT_NEIGHBORS) {
        const neighbor = current.plus(neighborStep.offset)
        const neighborKey = getFlightCellKey(neighbor)

        if (!isWithinFlightBounds(neighbor, bounds)) continue
        if (closedSet.has(neighborKey)) continue
        if (!canTraverseFlightStep(current, neighbor, startCell, obstacleKeys)) continue

        const tentativeG = baseCost + neighborStep.cost
        const previousG = gScore.get(neighborKey)
        if (previousG !== undefined && tentativeG >= previousG) continue

        cameFrom.set(neighborKey, bestKey)
        nodes.set(neighborKey, { pos: neighbor })
        gScore.set(neighborKey, tentativeG)
        fScore.set(neighborKey, tentativeG + getFlightHeuristic(neighbor, targetCell))

        if (!openSet.has(neighborKey)) {
          openKeys.push(neighborKey)
          openSet.add(neighborKey)
        }
      }
    }

    return null
  }

  async function flyDirectTo (targetPos, tolerance = 0.35, timeoutMs = 4000) {
    const target = targetPos.clone()

    return new Promise((resolve, reject) => {
      let finished = false
      let lastDistance = Number.POSITIVE_INFINITY
      let lastProgressAt = Date.now()
      let timeoutId = null

      const cleanup = () => {
        if (finished) return
        finished = true
        clearInterval(flyingInterval)
        if (timeoutId) clearTimeout(timeoutId)
        bot.entity.velocity.x = 0
        bot.entity.velocity.y = 0
        bot.entity.velocity.z = 0
      }

      const flyingInterval = setInterval(() => {
        const currentPos = bot.entity.position
        const direction = target.minus(currentPos)
        const distance = direction.norm()

        if (distance < tolerance) {
          cleanup()
          resolve()
          return
        }

        if (distance < lastDistance - 0.05) {
          lastDistance = distance
          lastProgressAt = Date.now()
        } else if (Date.now() - lastProgressAt > 1200) {
          cleanup()
          reject(new Error('Fly segment stuck'))
          return
        }

        const speed = Math.min(0.6, Math.max(0.18, distance * 0.2))
        const normalized = direction.normalize()
        bot.entity.velocity.x = normalized.x * speed
        bot.entity.velocity.y = normalized.y * speed
        bot.entity.velocity.z = normalized.z * speed
      }, 50)

      timeoutId = setTimeout(() => {
        cleanup()
        reject(new Error('Fly timeout'))
      }, timeoutMs)
    })
  }

  // 飞行到指定位置（使用 A* 绕开障碍）
  async function flyTo (targetPos, tolerance = 1.5) {
    const target = targetPos.clone()
    let lastError = null

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        bot.creative.startFlying()
      } catch (e) {}

      const path = findFlightPath(bot.entity.position, target, attempt * 3, 6000 + attempt * 2500)
      if (!path || path.length === 0) {
        lastError = new Error('Flight A* path not found')
        continue
      }

      try {
        for (let index = 0; index < path.length; index++) {
          const waypoint = path[index]
          const isLast = index === path.length - 1
          await flyDirectTo(waypoint, isLast ? tolerance : 0.35, isLast ? 6000 : 3500)
        }
        return
      } catch (err) {
        lastError = err
      }
    }

    throw lastError || new Error('Fly timeout')
  }

  bot.builder.enableFlight = enableFlight
  bot.builder.flyTo = flyTo

  async function equipItem (id) {
    if (bot.inventory.items().length > 30) {
      bot.chat('/clear')
      await wait(1000)
    }
    if (!bot.inventory.items().find(x => x.type === id)) {
      const slot = bot.inventory.firstEmptyInventorySlot()
      await bot.creative.setInventorySlot(slot !== null ? slot : 36, new Item(id, 1))
    }
    const item = bot.inventory.items().find(x => x.type === id)
    await bot.equip(item, 'hand')
  }

  bot.builder.equipItem = equipItem

  // /fill ~-20 ~ ~-20 ~20 ~10 ~20 minecraft:air

  // 位置锁定文件目录
  const POS_LOCK_DIR = require('path').join(__dirname, '.build_locks/positions')

  // 确保位置锁目录存在
  function ensurePosLockDir () {
    const fs = require('fs')
    if (!fs.existsSync(POS_LOCK_DIR)) {
      fs.mkdirSync(POS_LOCK_DIR, { recursive: true })
    }
  }

  // 锁定机器人当前位置
  function lockPosition (robotId, pos) {
    ensurePosLockDir()
    const fs = require('fs')
    const lockFile = require('path').join(POS_LOCK_DIR, `${robotId}.pos`)
    try {
      fs.writeFileSync(lockFile, JSON.stringify({
        robotId,
        x: Math.floor(pos.x),
        y: Math.floor(pos.y),
        z: Math.floor(pos.z),
        timestamp: Date.now()
      }))
    } catch (e) {}
  }

  // 获取所有机器人的位置
  function getOtherBotPositions (myId) {
    ensurePosLockDir()
    const fs = require('fs')
    const positions = []
    try {
      const files = fs.readdirSync(POS_LOCK_DIR)
      for (const file of files) {
        if (!file.endsWith('.pos')) continue
        try {
          const data = JSON.parse(fs.readFileSync(require('path').join(POS_LOCK_DIR, file), 'utf8'))
          // 过期检查（30秒）
          if (Date.now() - data.timestamp > 30000) continue
          if (data.robotId !== myId) {
            positions.push({ x: data.x, y: data.y, z: data.z })
          }
        } catch (e) {}
      }
    } catch (e) {}
    return positions
  }

  // 检查位置是否太靠近其他机器人
  function isTooCloseToOthers (myId, pos, minDistance = 3) {
    const others = getOtherBotPositions(myId)
    for (const other of others) {
      const dx = pos.x - other.x
      const dy = pos.y - other.y
      const dz = pos.z - other.z
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (dist < minDistance) return true
    }
    return false
  }

  bot.builder.build = async (build, robotId = null, useFlight = true) => {
    // 设置机器人ID用于任务锁定
    build.robotId = robotId || bot.username
    bot.builder.currentRobotId = build.robotId
    build.cleanupLocks()

    // 启用飞行模式
    if (useFlight) {
      try {
        await enableFlight()
      } catch (e) {
        console.log(`[${build.robotId}] Could not enable flight, continuing without it`)
      }
    }

    // 辅助方块追踪（pathfinder 放置的临时方块）
    const scaffoldBlocks = new Map() // pos -> { stateId, timestamp }
    const buildArea = {
      min: build.min,
      max: build.max
    }
    
    // 检查位置是否在建筑区域内
    function isInBuildArea (pos) {
      return pos.x >= buildArea.min.x && pos.x < buildArea.max.x &&
             pos.y >= buildArea.min.y && pos.y < buildArea.max.y &&
             pos.z >= buildArea.min.z && pos.z < buildArea.max.z
    }
    
    // 不再基于全局 blockUpdate 推断脚手架；多 bot 时会误删其他机器人的支撑块。
    const onBlockUpdate = () => {}
    
    let lastRepositionTime = 0
    let lastRepositionKey = null
    let zoneFocusAction = null

    function isSameZone (left, right) {
      if (!left || !right) return false
      return build.getZoneKey(left) === build.getZoneKey(right)
    }

    function updateZoneFocus (action) {
      if (!action) return
      if (zoneFocusAction && !isSameZone(zoneFocusAction, action)) {
        build.releaseZoneReservation(zoneFocusAction)
      }
      build.reserveZone(action)
      zoneFocusAction = action
    }


    function getLiveReferenceBlock (action) {
      if (!action || action.type !== 'place') return null

      const faces = build.getLiveReferenceDirections(action.state, action.pos)
      for (const face of faces) {
        const refPos = action.pos.plus(face)
        const refBlock = bot.blockAt(refPos)
        if (refBlock && refBlock.name !== 'air') {
          return { refBlock, placeFace: face.scaled(-1) }
        }
      }

      return null
    }

    function getSafeActionAnchor (action) {
      if (!action) return null

      if (action.type === 'place') {
        const liveReference = getLiveReferenceBlock(action)
        if (!liveReference) return null
        return liveReference.refBlock.position.offset(0.5, 1.5, 0.5)
      }

      return action.pos.offset(0.5, 1.5, 0.5)
    }

    function getApproachGoal (action) {
      if (!action) return null

      if (action.type === 'place') {
        const properties = build.properties[action.state] || {}
        const half = properties.half ? properties.half : properties.type
        const faces = build.getLiveReferenceDirections(action.state, action.pos)
        if (faces.length > 0) {
          const { facing, is3D } = build.getFacing(action.state, properties.facing)
          return new goals.GoalPlaceBlock(action.pos, bot.world, {
            faces,
            facing,
            facing3D: is3D,
            half
          })
        }
      }

      return new goals.GoalNear(action.pos.x, action.pos.y, action.pos.z, 4)
    }

    async function proactivelyMoveTowards (action, reason = 'reposition') {
      if (!action) return false

      const key = reason + ':' + action.type + ':' + action.pos.x + ',' + action.pos.y + ',' + action.pos.z + ':' + (exactProperties ? 'exact' : 'type')
      const now = Date.now()
      if (key === lastRepositionKey && now - lastRepositionTime < 1500) return false

      const goal = getApproachGoal(action)
      if (!goal) return false
      if (goal.isEnd(bot.entity.position.floored())) return false

      lastRepositionKey = key
      lastRepositionTime = now

      try {
        bot.pathfinder.setMovements(movements)
        await withTimeout(bot.pathfinder.goto(goal), 5000, 'Proactive path timeout')
        return true
      } catch (moveErr) {
        if (!useFlight) return false

        const anchor = getSafeActionAnchor(action)
        if (!anchor) return false

        try {
          bot.creative.startFlying()
          await withTimeout(flyTo(anchor, 0.75), 8000, 'Proactive fly timeout')
          return true
        } catch (flyErr) {
          return false
        }
      }
    }

    function getActionStagingAnchor (action) {
      return getSafeActionAnchor(action) || action.pos.offset(0.5, 1.5, 0.5)
    }

    function getActionFocusPos (action) {
      return getActionStagingAnchor(action) || action.pos.offset(0.5, 0.5, 0.5)
    }

    function getActionZoneKey (action) {
      const pos = action.pos
      return Math.floor(pos.x / 8) + ':' + Math.floor(pos.y / 6) + ':' + Math.floor(pos.z / 8)
    }

    function buildZoneCounts (actions) {
      const zoneCounts = new Map()
      for (const action of actions) {
        const key = getActionZoneKey(action)
        zoneCounts.set(key, (zoneCounts.get(key) || 0) + 1)
      }
      return zoneCounts
    }

    function countBotsNear (positions, pos, radius = 6) {
      let count = 0
      for (const other of positions) {
        const dx = pos.x - other.x
        const dy = pos.y - other.y
        const dz = pos.z - other.z
        if (dx * dx + dy * dy + dz * dz <= radius * radius) count++
      }
      return count
    }

    let phaseInitialActionCount = Math.max(1, build.actions.length)

    function getActionDistance (action) {
      const focusPos = getActionFocusPos(action)
      if (!focusPos) return Number.POSITIVE_INFINITY
      return bot.entity.position.distanceTo(focusPos)
    }

    function getPhaseProgress () {
      return 1 - (build.actions.length / Math.max(1, phaseInitialActionCount))
    }

    function getNearbyPreferredActions (actions, forMovement = false) {
      if (!actions || actions.length === 0) return []

      let nearestDistance = Number.POSITIVE_INFINITY
      let nearestAction = null
      for (const action of actions) {
        const distance = getActionDistance(action)
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearestAction = action
        }
      }

      if (!nearestAction) return actions

      const progress = getPhaseProgress()
      const baseSlack = forMovement ? 8 : 5
      const progressSlack = progress > 0.7 ? 4 : 0
      const distanceLimit = Math.min(forMovement ? 30 : 22, nearestDistance + baseSlack + progressSlack)
      const nearestZoneKey = getActionZoneKey(nearestAction)
      const preferred = actions.filter(action => {
        const distance = getActionDistance(action)
        if (distance <= distanceLimit) return true
        return progress > 0.8 && getActionZoneKey(action) === nearestZoneKey && distance <= distanceLimit + 6
      })

      return preferred.length > 0 ? preferred : actions
    }

    function scoreAction (action, zoneCounts, otherBots, forMovement = false) {
      const focusPos = getActionFocusPos(action)
      if (!focusPos) return Number.NEGATIVE_INFINITY

      const reservationState = build.getZoneReservationState(action)
      const reservedBySelf = reservationState.ownCount > 0
      const zoneFullForOthers = !reservedBySelf && reservationState.totalCount >= reservationState.capacity
      const distance = bot.entity.position.distanceTo(focusPos)
      const crowd = countBotsNear(otherBots, focusPos, forMovement ? 7 : 5)
      const zoneLoad = zoneCounts.get(getActionZoneKey(action)) || 1
      const progress = getPhaseProgress()
      const lateGameBoost = progress > 0.7 ? (progress - 0.7) / 0.3 : 0
      const actionBias = action.type === 'dig' ? 6 : 0
      const crowdPenalty = crowd * (forMovement ? 16 : 26)
      const distancePenalty = distance * (forMovement ? (1.25 + lateGameBoost * 0.5) : (1.7 + lateGameBoost * 0.8))
      const frontierBonus = Math.min(zoneLoad, 16) * (forMovement ? (16 - lateGameBoost * 6) : (10 - lateGameBoost * 4))
      const reservationBonus = reservedBySelf ? 18 : 0
      const zonePressurePenalty = reservationState.otherCount * (forMovement ? (6 - lateGameBoost * 2) : (10 - lateGameBoost * 3))
      const fullZonePenalty = zoneFullForOthers ? (forMovement ? (18 - lateGameBoost * 6) : (28 - lateGameBoost * 10)) : 0
      const spareCapacityBonus = !zoneFullForOthers && reservationState.capacity > reservationState.totalCount ? Math.min(2, reservationState.capacity - reservationState.totalCount) * (forMovement ? 6 : 4) : 0
      const nearbyBonus = Math.max(0, (forMovement ? 18 : 24) - distance) * (forMovement ? 1.6 : 2.2)
      const tieBreaker = (hashString(build.robotId + ':' + action.pos.x + ',' + action.pos.y + ',' + action.pos.z) % 100) / 100
      return frontierBonus + actionBias + reservationBonus + spareCapacityBonus + nearbyBonus + tieBreaker - crowdPenalty - distancePenalty - zonePressurePenalty - fullZonePenalty
    }

    function pickBestAction (actions, forMovement = false) {
      if (!actions || actions.length === 0) return null

      const preferredActions = getNearbyPreferredActions(actions, forMovement)
      const zoneCounts = buildZoneCounts(preferredActions)
      const otherBots = getOtherBotPositions(build.robotId)
      let bestAction = null
      let bestScore = Number.NEGATIVE_INFINITY

      for (const action of preferredActions) {
        const score = scoreAction(action, zoneCounts, otherBots, forMovement)
        if (score > bestScore) {
          bestScore = score
          bestAction = action
        }
      }

      return bestAction
    }

    function sortActionsForAllocation (actions, forMovement = false) {
      const preferredActions = getNearbyPreferredActions(actions, forMovement)
      const zoneCounts = buildZoneCounts(preferredActions)
      const otherBots = getOtherBotPositions(build.robotId)
      return preferredActions.slice().sort((left, right) => {
        const rightScore = scoreAction(right, zoneCounts, otherBots, forMovement)
        const leftScore = scoreAction(left, zoneCounts, otherBots, forMovement)
        return rightScore - leftScore
      })
    }

    function getUnsatisfiedActions () {
      return build.actions.filter(action => !build.isActionSatisfied(action, bot.world.getBlock(action.pos), { exactProperties }))
    }

    function pickNearestPendingAction (actions) {
      if (!actions || actions.length === 0) return null

      let bestAction = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (const action of actions) {
        const distance = getActionDistance(action)
        if (distance < bestDistance) {
          bestDistance = distance
          bestAction = action
        }
      }
      return bestAction
    }

    function pickRecoveryAction () {
      return pickBestAction(build.getAvailableActions({ exactProperties }), true) ||
        pickBestAction(build.getAvailableActions({ exactProperties, includeLocked: true }), true) ||
        pickNearestPendingAction(getUnsatisfiedActions())
    }

    function resetWorkFocus () {
      bot.pathfinder.stop()
      if (typeof bot.clearControlStates === 'function') bot.clearControlStates()
      build.cleanupLocks()
      failureCount.clear()
      if (zoneFocusAction) build.releaseZoneReservation(zoneFocusAction)
      zoneFocusAction = null
    }

    // 清理辅助方块
    async function cleanupScaffoldBlocks () {
      const toRemove = []
      const now = Date.now()
      
      for (const [key, info] of scaffoldBlocks) {
        // 跳过太新的方块（可能还在使用中）
        if (now - info.timestamp < 3000) continue
        
        const pos = new (require('vec3').Vec3)(info.x, info.y, info.z)
        
        // 检查周围是否有其他机器人
        if (isTooCloseToOthers(build.robotId, pos, 3)) continue
        
        toRemove.push({ key, pos })
      }
      
      // 移除辅助方块
      for (const { key, pos } of toRemove) {
        try {
          const block = bot.blockAt(pos)
          if (block && block.name !== 'air') {
            await withTimeout(bot.dig(block), 5000, 'Dig scaffold timeout')
            scaffoldBlocks.delete(key)
            console.log(`[${build.robotId}] Removed scaffold at (${pos.x}, ${pos.y}, ${pos.z})`)
          } else {
            scaffoldBlocks.delete(key)
          }
        } catch (e) {
          // 移除失败，稍后重试
        }
      }
    }

    let exactProperties = false
    build.updateActions({ exactProperties })

    // 看门狗 - 检测是否卡住
    let lastActionTime = Date.now()
    let lastMovementTime = Date.now()
    let lastRecoveryTime = 0
    let lastObservedPosition = bot.entity.position.clone()
    let lastActionsCount = build.actions.length
    let stuckCount = 0
    const STUCK_THRESHOLD = 30000
    const IDLE_MOVEMENT_THRESHOLD = 12000
    const IDLE_RECOVERY_COOLDOWN = 4000
    const MAX_STUCK_COUNT = 2

    function markMovementProgress () {
      lastMovementTime = Date.now()
    }

    function updateMovementProgress () {
      const currentPos = bot.entity.position
      if (currentPos.distanceTo(lastObservedPosition) >= 0.75) {
        lastObservedPosition = currentPos.clone()
        markMovementProgress()
      }
    }

    // 定期清理过期锁和更新位置
    const cleanupInterval = setInterval(() => {
      Build.cleanupExpiredLocks()
      if (zoneFocusAction && !build.touchZoneReservation(zoneFocusAction)) {
        zoneFocusAction = null
      }
    }, 5000)

    // 定期同步动作列表
    const syncInterval = setInterval(() => {
      build.updateActions({ exactProperties })
    }, 3000)

    // 定期更新位置锁
    const posUpdateInterval = setInterval(() => {
      updateMovementProgress()
      lockPosition(build.robotId, bot.entity.position)
    }, 1000)

    // 定期清理辅助方块
    const scaffoldCleanupInterval = setInterval(async () => {
      try {
        await cleanupScaffoldBlocks()
      } catch (e) {
        // 忽略清理错误
      }
    }, 10000) // 每10秒清理一次

    // 看门狗检查
    const watchdogInterval = setInterval(async () => {
      const now = Date.now()
      updateMovementProgress()
      const timeSinceLastAction = now - lastActionTime
      const timeSinceLastMove = now - lastMovementTime
      const noProgress = build.actions.length === lastActionsCount && timeSinceLastAction > STUCK_THRESHOLD
      const idleWithWork = build.actions.length > 0 && timeSinceLastMove > IDLE_MOVEMENT_THRESHOLD && timeSinceLastAction > IDLE_MOVEMENT_THRESHOLD

      if (noProgress || idleWithWork) {
        stuckCount++
        console.log(`[${build.robotId}] Watchdog: action idle ${Math.round(timeSinceLastAction / 1000)}s, move idle ${Math.round(timeSinceLastMove / 1000)}s, stuck count: ${stuckCount}`)

        if (stuckCount >= MAX_STUCK_COUNT && now - lastRecoveryTime > IDLE_RECOVERY_COOLDOWN) {
          console.log(`[${build.robotId}] Watchdog: forcing recovery and retarget...`)
          lastRecoveryTime = now
          resetWorkFocus()
          const recoveryAction = pickRecoveryAction()
          if (recoveryAction) {
            updateZoneFocus(recoveryAction)
            try {
              await proactivelyMoveTowards(recoveryAction, 'watchdog-recovery')
            } catch (e) {}
          }
          stuckCount = 0
          lastActionTime = now
          lastMovementTime = now
        }
      } else {
        stuckCount = 0
      }

      lastActionsCount = build.actions.length
    }, 5000)

    // 失败计数器
    let consecutiveFailures = 0
    const MAX_FAILURES = 3
    
    // 记录每个位置失败次数
    const failureCount = new Map()
    const MAX_FAILURES_PER_ACTION = 2
    
    // === 初始化：检查是否需要放置基础方块 ===
    if (useFlight) {
      // 检查建筑区域底部是否有地面方块
      let hasFoundation = false
      for (let y = build.min.y - 1; y >= build.min.y - 5 && !hasFoundation; y--) {
        for (let x = build.min.x; x <= build.min.x + 3 && !hasFoundation; x++) {
          for (let z = build.min.z; z <= build.min.z + 3 && !hasFoundation; z++) {
            const block = bot.blockAt(new Vec3(x, y, z))
            if (block && block.name !== 'air') {
              hasFoundation = true
              console.log(`[${build.robotId}] Found foundation at (${x}, ${y}, ${z})`)
            }
          }
        }
      }
      
      if (!hasFoundation) {
        console.log(`[${build.robotId}] No foundation, placing base block at ground level...`)
        
        // 飞到建筑起点附近
        const basePos = build.min.clone()
        try {
          const nearGoal = new goals.GoalNear(basePos.x, basePos.y - 1, basePos.z, 3)
          await withTimeout(bot.pathfinder.goto(nearGoal), 15000, 'Fly to base timeout')
        } catch (e) {
          console.log(`[${build.robotId}] Using creative fly to reach base`)
          try {
            await withTimeout(flyTo(new Vec3(basePos.x + 0.5, basePos.y, basePos.z + 0.5), 0.9), 10000, 'Base fly timeout')
          } catch (e2) {}
        }
        
        // 在地面放一个基础方块
        // 先找到地面
        let groundY = basePos.y - 1
        for (let y = basePos.y - 1; y >= basePos.y - 10; y--) {
          const block = bot.blockAt(new Vec3(basePos.x, y, basePos.z))
          if (block && block.name !== 'air') {
            groundY = y
            break
          }
        }
        
        // 在地面上方放基础方块
        const foundationPos = new Vec3(basePos.x, groundY + 1, basePos.z)
        
        // 使用第一个建筑方块作为基础
        const firstAction = build.actions.find(a => a.type === 'place')
        if (firstAction) {
          const item = build.getItemForState(firstAction.state)
          if (item) {
            await equipItem(item.id)
            
            // 飞到基础位置上方
            await withTimeout(flyTo(foundationPos.offset(0.5, 2, 0.5), 0.75), 10000, 'Foundation fly timeout')
            await wait(100)
            
            // 向下放置方块
            const groundBlock = bot.blockAt(foundationPos.offset(0, -1, 0))
            if (groundBlock && groundBlock.name !== 'air') {
              try {
                await bot.placeBlock(groundBlock, new Vec3(0, 1, 0))
                console.log(`[${build.robotId}] Foundation block placed at (${foundationPos.x}, ${foundationPos.y}, ${foundationPos.z})`)
              } catch (e) {
                console.log(`[${build.robotId}] Could not place foundation: ${e.message}`)
              }
            }
          }
        }
      }
    }

    try {
      const phases = [
        { name: 'type', exactProperties: false },
        { name: 'properties', exactProperties: true }
      ]

      for (const phase of phases) {
        exactProperties = phase.exactProperties
        failureCount.clear()
        consecutiveFailures = 0

        if (exactProperties) {
          console.log(`[${build.robotId}] Type placement complete, starting property correction...`)
          await wait(500)
        } else {
          console.log(`[${build.robotId}] Starting type-first placement...`)
        }

        build.updateActions({ exactProperties })
        phaseInitialActionCount = Math.max(1, build.actions.length)
        lastActionsCount = build.actions.length

        const phaseTarget = pickBestAction(build.getAvailableActions({ exactProperties, includeLocked: true }), true)
        if (phaseTarget) {
          updateZoneFocus(phaseTarget)
          if (await proactivelyMoveTowards(phaseTarget, exactProperties ? 'phase-exact' : 'phase-type')) markMovementProgress()
        }

        while (build.actions.length > 0) {
        updateMovementProgress()
        // 更新位置锁
        lockPosition(build.robotId, bot.entity.position)

        const actions = build.getAvailableActions({ exactProperties })
        console.log(`[${build.robotId}] ${actions.length} available actions, ${build.actions.length} remaining`)
        if (actions.length === 0) {
          console.log(`[${build.robotId}] No actions available, repositioning...`)
          const pendingAction = pickRecoveryAction()
          if (pendingAction) {
            updateZoneFocus(pendingAction)
            if (await proactivelyMoveTowards(pendingAction, 'no-actions')) markMovementProgress()
          } else {
            await wait(150)
          }
          build.updateActions({ exactProperties })
          if (build.actions.length === 0) {
            console.log(`[${build.robotId}] All actions completed!`)
            break
          }
          continue
        }

        const validActions = actions.filter(action => {
          const key = `${action.pos.x},${action.pos.y},${action.pos.z}`
          const fails = failureCount.get(key) || 0
          return fails < MAX_FAILURES_PER_ACTION
        })

        if (validActions.length === 0) {
          console.log(`[${build.robotId}] All actions failed too many times, resetting...`)
          failureCount.clear()
          const fallbackAction = pickRecoveryAction() || pickBestAction(actions, true)
          if (fallbackAction) {
            updateZoneFocus(fallbackAction)
            if (await proactivelyMoveTowards(fallbackAction, 'failed-actions')) markMovementProgress()
          } else {
            await wait(150)
          }
          continue
        }

        const sortedActions = sortActionsForAllocation(validActions)
        const broadSortedActions = validActions.length === sortedActions.length ? sortedActions : validActions.slice().sort((left, right) => getActionDistance(left) - getActionDistance(right))
        let action = null
        for (const candidate of sortedActions) {
          if (build.lockAction(candidate)) {
            updateZoneFocus(candidate)
            action = candidate
            break
          }
        }

        if (!action) {
          for (const candidate of broadSortedActions) {
            if (build.lockAction(candidate)) {
              updateZoneFocus(candidate)
              action = candidate
              break
            }
          }
        }

        if (!action) {
          if (zoneFocusAction) build.releaseZoneReservation(zoneFocusAction)
          zoneFocusAction = null
          const relocationTarget = pickRecoveryAction() || broadSortedActions[0] || sortedActions[0]
          if (relocationTarget) {
            updateZoneFocus(relocationTarget)
            if (await proactivelyMoveTowards(relocationTarget, 'lock-wait')) markMovementProgress()
          }
          await wait(50)
          continue
        }

        let success = false
        try {
          if (action.type === 'place') {
            const currentBlock = bot.blockAt(action.pos)
            if (build.isActionSatisfied(action, currentBlock, { exactProperties })) {
              success = true
            } else {
              if (exactProperties && build.canInteractToMatch(action, currentBlock)) {
                const interactGoal = new goals.GoalNear(action.pos.x, action.pos.y, action.pos.z, 3)
                if (!interactGoal.isEnd(bot.entity.position.floored())) {
                  bot.pathfinder.setMovements(movements)
                  try {
                    await withTimeout(bot.pathfinder.goto(interactGoal), 15000, 'Interact path timeout')
                  } catch (moveErr) {
                    if (useFlight) {
                      bot.creative.startFlying()
                      await withTimeout(flyTo(action.pos.offset(0.5, 1.5, 0.5), 0.75), 15000, 'Interact fly timeout')
                    } else {
                      throw moveErr
                    }
                  }
                }

                build.touchActionLock(action)
                await bot.lookAt(currentBlock.position.offset(0.5, 0.5, 0.5), true)
                await withTimeout(bot.activateBlock(currentBlock), 5000, 'Activate block timeout')
                await wait(80)
                success = build.isActionSatisfied(action, bot.blockAt(action.pos), { exactProperties })
                if (!success) {
                  build.unlockAction(action)
                  await proactivelyMoveTowards(action, 'missing-ref')
                  await wait(50)
                  continue
                }
              } else if (currentBlock && currentBlock.name !== 'air') {
                const clearGoal = new goals.GoalNear(action.pos.x, action.pos.y, action.pos.z, 3)
                if (!clearGoal.isEnd(bot.entity.position.floored())) {
                  bot.pathfinder.setMovements(movements)
                  try {
                    await withTimeout(bot.pathfinder.goto(clearGoal), 15000, 'Clear path timeout')
                  } catch (moveErr) {
                    if (useFlight) {
                      bot.creative.startFlying()
                      await withTimeout(flyTo(action.pos.offset(0.5, 1.5, 0.5), 0.75), 15000, 'Clear fly timeout')
                    } else {
                      throw moveErr
                    }
                  }
                }

                build.touchActionLock(action)
                await withTimeout(bot.dig(currentBlock, true), 15000, 'Clear wrong block timeout')
                lastActionTime = Date.now()
                markMovementProgress()
                build.unlockAction(action)
                await wait(50)
                continue
              }

              const item = build.getItemForState(action.state)
              if (!item) {
                build.unlockAction(action)
                build.removeAction(action)
                continue
              }

              const properties = build.properties[action.state]
              const half = properties.half ? properties.half : properties.type
              const faces = build.getLiveReferenceDirections(action.state, action.pos)
              if (faces.length === 0) {
                build.unlockAction(action)
                await wait(50)
                continue
              }

              const { facing, is3D } = build.getFacing(action.state, properties.facing)
              const goal = new goals.GoalPlaceBlock(action.pos, bot.world, {
                faces,
                facing,
                facing3D: is3D,
                half
              })

              if (!goal.isEnd(bot.entity.position.floored())) {
                bot.pathfinder.setMovements(movements)
                try {
                  await withTimeout(bot.pathfinder.goto(goal), 20000, 'Place path timeout')
                } catch (moveErr) {
                  if (useFlight) {
                    const anchor = getSafeActionAnchor(action)
                    if (!anchor) {
                      build.unlockAction(action)
                      await wait(50)
                      continue
                    }

                    try {
                      bot.creative.startFlying()
                      await withTimeout(flyTo(anchor, 0.75), 10000, 'Place fly timeout')
                    } catch (flyErr) {
                      build.unlockAction(action)
                      await proactivelyMoveTowards(action, 'place-fly-timeout')
                      await wait(100)
                      continue
                    }
                  } else {
                    build.unlockAction(action)
                    await proactivelyMoveTowards(action, 'place-path-timeout')
                    await wait(100)
                    continue
                  }
                }
              }

              build.touchActionLock(action)
              await equipItem(item.id)

              const liveReference = getLiveReferenceBlock(action)
              if (!liveReference) {
                build.unlockAction(action)
                await wait(50)
                continue
              }

              const fallbackRefBlock = liveReference.refBlock
              const fallbackPlaceFace = liveReference.placeFace
              const faceAndRef = goal.getFaceAndRef(bot.entity.position.floored().offset(0.5, 1.6, 0.5))

              const refBlock = faceAndRef ? bot.blockAt(faceAndRef.ref) : fallbackRefBlock
              if (!refBlock || refBlock.name === 'air') {
                build.unlockAction(action)
                await wait(50)
                continue
              }

              const placeFace = faceAndRef ? faceAndRef.face.scaled(-1) : fallbackPlaceFace
              const delta = faceAndRef ? faceAndRef.to.minus(faceAndRef.ref) : null
              const sneak = interactable.indexOf(refBlock.name) >= 0

              let placeErr = null
              if (sneak) bot.setControlState('sneak', true)
              try {
                try {
                  if (delta) {
                    await bot._placeBlockWithOptions(refBlock, placeFace, { half, delta })
                  } else {
                    await bot._placeBlockWithOptions(refBlock, placeFace, { half })
                  }
                } catch (err) {
                  placeErr = err
                  try {
                    await bot.placeBlock(refBlock, placeFace)
                    placeErr = null
                  } catch (fallbackErr) {
                    placeErr = fallbackErr
                  }
                }
              } finally {
                if (sneak) bot.setControlState('sneak', false)
              }

              const placedBlock = bot.world.getBlock(action.pos)
              success = build.isActionSatisfied(action, placedBlock, { exactProperties })
              if (!success && placeErr) {
                build.unlockAction(action)
                await proactivelyMoveTowards(action, 'place-update-timeout')
                await wait(50)
                continue
              }
            }
          } else if (action.type === 'dig') {
            const block = bot.blockAt(action.pos)
            if (!block || block.name === 'air') {
              success = true
            } else {
              const digGoal = new goals.GoalNear(action.pos.x, action.pos.y, action.pos.z, 3)
              if (!digGoal.isEnd(bot.entity.position.floored())) {
                bot.pathfinder.setMovements(movements)
                try {
                  await withTimeout(bot.pathfinder.goto(digGoal), 15000, 'Dig path timeout')
                } catch (moveErr) {
                  if (useFlight) {
                    bot.creative.startFlying()
                    await withTimeout(flyTo(action.pos.offset(0.5, 1.5, 0.5), 0.75), 15000, 'Dig fly timeout')
                  } else {
                    throw moveErr
                  }
                }
              }

              build.touchActionLock(action)
              await withTimeout(bot.dig(block, true), 15000, 'Dig timeout')
              success = true
            }
          }
        } catch (e) {
          console.log(`[${build.robotId}] Error: ${e.message}`)
          const key = `${action.pos.x},${action.pos.y},${action.pos.z}`
          failureCount.set(key, (failureCount.get(key) || 0) + 1)
          build.unlockAction(action)
          consecutiveFailures++
          if (consecutiveFailures >= MAX_FAILURES) {
            console.log(`[${build.robotId}] Too many failures, switching targets...`)
            resetWorkFocus()
            await wait(200)
            consecutiveFailures = 0
          }
          await wait(80)
          continue
        }

        if (success) {
          consecutiveFailures = 0
          lastActionTime = Date.now()
          markMovementProgress()
          stuckCount = 0
          build.removeAction(action)
          
          // 目前不主动清理外部辅助方块，避免多 bot 误删他人的支撑块。
          
          await wait(50)
        }
      }
    }
    } finally {
      clearInterval(cleanupInterval)
      clearInterval(syncInterval)
      clearInterval(posUpdateInterval)
      clearInterval(watchdogInterval)
      clearInterval(scaffoldCleanupInterval)
      bot.removeListener('blockUpdate', onBlockUpdate)
      
      // 不做跨机器人脚手架清理，避免误删外部支撑块。
      
      build.cleanupLocks()
      if (zoneFocusAction) build.releaseZoneReservation(zoneFocusAction)
      bot.builder.currentRobotId = null
    }
  }
}

module.exports = {
  Build: require('./lib/Build'),
  builder: inject
}
