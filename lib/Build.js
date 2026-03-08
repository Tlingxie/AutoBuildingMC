const { Vec3 } = require('vec3')
const fs = require('fs')
const path = require('path')
const facingData = require('./facingData.json')

const { getShapeFaceCenters } = require('mineflayer-pathfinder/lib/shapes')

// 锁文件目录
const LOCK_DIR = path.join(__dirname, '../.build_locks')
const ZONE_RESERVATION_DIR = path.join(LOCK_DIR, 'zones')
const LOCK_TTL_MS = 15000
const ZONE_RESERVATION_TTL_MS = 15000
const ZONE_SIZE = { x: 8, y: 6, z: 8 }
const MIN_ZONE_RESERVATION_CAPACITY = 1
const MAX_ZONE_RESERVATION_CAPACITY = 6

// 确保锁目录存在
function ensureLockDir () {
  if (!fs.existsSync(LOCK_DIR)) {
    fs.mkdirSync(LOCK_DIR, { recursive: true })
  }
}

function ensureZoneReservationDir () {
  ensureLockDir()
  if (!fs.existsSync(ZONE_RESERVATION_DIR)) {
    fs.mkdirSync(ZONE_RESERVATION_DIR, { recursive: true })
  }
}

class Build {
  constructor (schematic, world, at, robotId = 'default') {
    this.schematic = schematic
    this.world = world
    this.at = at
    this.robotId = robotId
    this.lockDir = LOCK_DIR
    this.zoneReservationDir = ZONE_RESERVATION_DIR

    this.min = at.plus(schematic.offset)
    this.max = this.min.plus(schematic.size)

    this.actions = []

    ensureLockDir()
    ensureZoneReservationDir()

    // Cache of blockstate to block
    const Block = require('prismarine-block')(schematic.version)
    const mcData = require('minecraft-data')(schematic.version)
    this.blocks = {}
    this.properties = {}
    this.items = {}
    for (const stateId of schematic.palette) {
      const block = Block.fromStateId(stateId, 0)
      this.blocks[stateId] = block
      this.properties[stateId] = block.getProperties()
      this.items[stateId] = mcData.itemsByName[block.name]
    }

    this.updateActions()

    // How many actions ?
    // console.log(this.actions)
  }

  updateActions (options = {}) {
    const { exactProperties = true } = options
    this.actions = []
    const cursor = new Vec3(0, 0, 0)
    let digCount = 0, placeCount = 0, matchCount = 0
    
    for (cursor.y = this.min.y; cursor.y < this.max.y; cursor.y++) {
      for (cursor.z = this.min.z; cursor.z < this.max.z; cursor.z++) {
        for (cursor.x = this.min.x; cursor.x < this.max.x; cursor.x++) {
          const stateInWorld = this.world.getBlockStateId(cursor)
          const wantedState = this.schematic.getBlockStateId(cursor.minus(this.at))
          const blockInWorld = this.world.getBlock(cursor)
          if (stateInWorld !== wantedState) {
            if (wantedState === 0) {
              const action = { type: 'dig', pos: cursor.clone() }
              if (!this.isActionSatisfied(action, blockInWorld, { exactProperties })) {
                this.actions.push(action)
                digCount++
              } else {
                matchCount++
              }
            } else {
              const action = { type: 'place', pos: cursor.clone(), state: wantedState }
              if (!this.isActionSatisfied(action, blockInWorld, { exactProperties })) {
                this.actions.push(action)
                placeCount++
              } else {
                matchCount++
              }
            }
          } else {
            matchCount++
          }
        }
      }
    }
  }

  updateBlock (pos, options = {}) {
    // is in area ?
    this.updateActions(options)
  }

  getTargetBlock (stateId) {
    return this.blocks[stateId] || null
  }

  getTargetBlockName (stateId) {
    const block = this.getTargetBlock(stateId)
    return block ? block.name : null
  }

  isBlockTypeSatisfied (action, block = this.world.getBlock(action.pos)) {
    if (action.type === 'dig') {
      return !block || block.name === 'air'
    }

    const wantedName = this.getTargetBlockName(action.state)
    return Boolean(block) && block.name !== 'air' && block.name === wantedName
  }

  isActionSame (left, right) {
    if (!left || !right) return false
    if (left.type !== right.type) return false
    if (left.type === 'place' && left.state !== right.state) return false
    return left.pos.x === right.pos.x && left.pos.y === right.pos.y && left.pos.z === right.pos.z
  }

  findActionIndex (action) {
    return this.actions.findIndex(candidate => this.isActionSame(candidate, action))
  }

  getBlockProperties (block) {
    if (!block || typeof block.getProperties !== 'function') return {}
    return block.getProperties()
  }

  getPropertyDifferences (stateId, block) {
    const wanted = this.properties[stateId] || {}
    const current = this.getBlockProperties(block)
    const keys = new Set([...Object.keys(wanted), ...Object.keys(current)])
    const differences = []

    for (const key of keys) {
      if (wanted[key] !== current[key]) differences.push(key)
    }

    return differences
  }

  getDynamicPropertyKeys (blockName) {
    const keys = new Set()

    if (blockName.endsWith('_wall')) {
      keys.add('north')
      keys.add('south')
      keys.add('east')
      keys.add('west')
      keys.add('up')
    }

    if (blockName.endsWith('_fence') || blockName.endsWith('_pane') || blockName === 'iron_bars' || blockName.includes('glass_pane')) {
      keys.add('north')
      keys.add('south')
      keys.add('east')
      keys.add('west')
    }

    if (blockName.endsWith('_stairs')) {
      keys.add('shape')
    }

    return keys
  }

  canIgnorePropertyDifferences (stateId, block) {
    const wantedBlock = this.blocks[stateId]
    if (!block || !wantedBlock || block.name !== wantedBlock.name) return false

    const differences = this.getPropertyDifferences(stateId, block)
    if (differences.length === 0) return true

    const dynamicKeys = this.getDynamicPropertyKeys(block.name)
    return dynamicKeys.size > 0 && differences.every(key => dynamicKeys.has(key))
  }

  canInteractToMatch (action, block) {
    if (!action || action.type !== 'place') return false

    const wantedBlock = this.blocks[action.state]
    if (!block || !wantedBlock || block.name !== wantedBlock.name) return false

    const differences = this.getPropertyDifferences(action.state, block)
    if (differences.length === 0) return false

    const supportsOpenToggle = block.name.includes('trapdoor') || block.name.endsWith('_door') || block.name.endsWith('_fence_gate')
    if (!supportsOpenToggle) return false

    return differences.every(key => key === 'open')
  }

  isActionSatisfied (action, block = this.world.getBlock(action.pos), options = {}) {
    const { exactProperties = true } = options

    if (action.type === 'dig') {
      return !block || block.name === 'air'
    }

    if (!this.isBlockTypeSatisfied(action, block)) return false
    if (!exactProperties) return true
    if (block.stateId === action.state) return true

    return this.canIgnorePropertyDifferences(action.state, block)
  }

  getItemForState (stateId) {
    return this.items[stateId]
  }

  getFacing (stateId, facing) {
    if (!facing) return { facing: null, faceDirection: false, is3D: false }
    const block = this.blocks[stateId]
    const data = facingData[block.name]
    if (data.inverted) {
      if (facing === 'up') facing = 'down'
      else if (facing === 'down') facing = 'up'
      else if (facing === 'north') facing = 'south'
      else if (facing === 'south') facing = 'north'
      else if (facing === 'west') facing = 'east'
      else if (facing === 'east') facing = 'west'
    }
    return { facing, faceDirection: data.faceDirection, is3D: data.is3D }
  }

  getLiveReferenceDirections (stateId, pos) {
    const properties = this.properties[stateId] || {}
    const half = properties.half ? properties.half : properties.type

    return this.getPossibleDirections(stateId, pos).filter(dir => {
      const block = this.world.getBlock(pos.plus(dir))
      if (!block || block.name === 'air' || !block.shapes) return false
      return getShapeFaceCenters(block.shapes, dir.scaled(-1), half).length > 0
    })
  }

  hasLiveReference (stateId, pos) {
    return this.getLiveReferenceDirections(stateId, pos).length > 0
  }

  getPossibleDirections (stateId, pos) {
    const faces = [true, true, true, true, true, true]
    const properties = this.properties[stateId]
    const block = this.blocks[stateId]
    if (properties.axis) {
      if (properties.axis === 'x') faces[0] = faces[1] = faces[2] = faces[3] = false
      if (properties.axis === 'y') faces[2] = faces[3] = faces[4] = faces[5] = false
      if (properties.axis === 'z') faces[0] = faces[1] = faces[4] = faces[5] = false
    }
    if (properties.half === 'upper') return []
    if (properties.half === 'top' || properties.type === 'top') faces[0] = faces[1] = false
    if (properties.half === 'bottom' || properties.type === 'bottom') faces[0] = faces[1] = false
    if (properties.facing) {
      const { facing, faceDirection } = this.getFacing(stateId, properties.facing)
      if (faceDirection) {
        if (facing === 'north') faces[0] = faces[1] = faces[2] = faces[4] = faces[5] = false
        else if (facing === 'south') faces[0] = faces[1] = faces[3] = faces[4] = faces[5] = false
        else if (facing === 'west') faces[0] = faces[1] = faces[2] = faces[3] = faces[4] = false
        else if (facing === 'east') faces[0] = faces[1] = faces[2] = faces[3] = faces[5] = false
        else if (facing === 'up') faces[1] = faces[2] = faces[3] = faces[4] = faces[5] = false
        else if (facing === 'down') faces[0] = faces[2] = faces[3] = faces[4] = faces[5] = false
      }
    }
    if (properties.hanging) faces[0] = faces[2] = faces[3] = faces[4] = faces[5] = false
    if (block.material === 'plant') faces[1] = faces[2] = faces[3] = faces[4] = faces[5] = false

    let dirs = []
    const faceDir = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]
    for (let i = 0; i < faces.length; i++) {
      if (faces[i]) dirs.push(faceDir[i])
    }

    // 过滤掉不支持的面（基于参考方块的形状）
    const half = properties.half ? properties.half : properties.type
    const filteredDirs = dirs.filter(dir => {
      const block = this.world.getBlock(pos.plus(dir))
      if (!block || !block.shapes) return true // 如果数据未加载，保留这个方向
      return getShapeFaceCenters(block.shapes, dir.scaled(-1), half).length > 0
    })

    // 如果过滤后没有方向，返回原始方向（更宽松）
    return filteredDirs.length > 0 ? filteredDirs : dirs
  }

  removeAction (action) {
    const index = this.findActionIndex(action)
    if (index !== -1) {
      this.actions.splice(index, 1)
    }
    this.unlockAction(action)
    this.releaseZoneReservation(action)
  }

  // 生成锁文件的唯一键
  getLockKey (action) {
    const pos = action.pos
    return `${pos.x}_${pos.y}_${pos.z}`
  }

  getZoneKeyFromPos (pos) {
    return `${Math.floor(pos.x / ZONE_SIZE.x)}_${Math.floor(pos.y / ZONE_SIZE.y)}_${Math.floor(pos.z / ZONE_SIZE.z)}`
  }

  getZoneKey (action) {
    return this.getZoneKeyFromPos(action.pos)
  }

  getZoneReservationFile (action) {
    return path.join(this.zoneReservationDir, `${this.getZoneKey(action)}.zone`)
  }

  getZoneReservationCapacity (action) {
    const zoneKey = this.getZoneKey(action)
    let zoneLoad = 0

    for (const candidate of this.actions) {
      if (this.getZoneKey(candidate) === zoneKey) zoneLoad++
    }

    const totalActions = this.actions.length
    let capacity = MIN_ZONE_RESERVATION_CAPACITY

    if (zoneLoad >= 24) capacity = MAX_ZONE_RESERVATION_CAPACITY
    else if (zoneLoad >= 12) capacity = 3
    else if (zoneLoad >= 4) capacity = 2

    if (totalActions <= 160) capacity = Math.max(capacity, Math.min(MAX_ZONE_RESERVATION_CAPACITY, Math.max(2, zoneLoad + 1)))
    if (totalActions <= 64) capacity = Math.max(capacity, Math.min(MAX_ZONE_RESERVATION_CAPACITY, Math.max(4, zoneLoad + 1)))
    if (totalActions <= 24) capacity = Math.max(capacity, Math.min(MAX_ZONE_RESERVATION_CAPACITY, Math.max(5, zoneLoad + 2)))

    return Math.max(MIN_ZONE_RESERVATION_CAPACITY, Math.min(MAX_ZONE_RESERVATION_CAPACITY, capacity))
  }

  normalizeZoneReservationData (action, reservation) {
    const zoneKey = this.getZoneKey(action)
    const capacity = this.getZoneReservationCapacity(action)
    const now = Date.now()
    const reservations = []

    if (reservation) {
      if (Array.isArray(reservation.reservations)) {
        for (const entry of reservation.reservations) {
          if (!entry || !entry.robotId || !entry.timestamp) continue
          if (now - entry.timestamp > ZONE_RESERVATION_TTL_MS) continue
          reservations.push({
            robotId: entry.robotId,
            timestamp: entry.timestamp,
            pos: entry.pos || null
          })
        }
      } else if (reservation.robotId && reservation.timestamp && now - reservation.timestamp <= ZONE_RESERVATION_TTL_MS) {
        reservations.push({
          robotId: reservation.robotId,
          timestamp: reservation.timestamp,
          pos: reservation.pos || null
        })
      }
    }

    const deduped = []
    const seen = new Set()
    for (const entry of reservations) {
      if (seen.has(entry.robotId)) continue
      seen.add(entry.robotId)
      deduped.push(entry)
    }

    return {
      zoneKey,
      capacity,
      reservations: deduped
    }
  }

  readZoneReservationData (action) {
    const zoneFile = this.getZoneReservationFile(action)
    if (!fs.existsSync(zoneFile)) return this.normalizeZoneReservationData(action, null)

    try {
      const reservation = JSON.parse(fs.readFileSync(zoneFile, 'utf8'))
      const normalized = this.normalizeZoneReservationData(action, reservation)
      if (normalized.reservations.length === 0) {
        try { fs.unlinkSync(zoneFile) } catch (_) {}
      }
      return normalized
    } catch (e) {
      try { fs.unlinkSync(zoneFile) } catch (_) {}
      return this.normalizeZoneReservationData(action, null)
    }
  }

  writeZoneReservationData (action, data) {
    const zoneFile = this.getZoneReservationFile(action)
    if (!data || !data.reservations || data.reservations.length === 0) {
      try { if (fs.existsSync(zoneFile)) fs.unlinkSync(zoneFile) } catch (_) {}
      return true
    }

    const normalized = this.normalizeZoneReservationData(action, data)
    try {
      fs.writeFileSync(zoneFile, JSON.stringify(normalized))
      return true
    } catch (e) {
      return false
    }
  }

  getZoneReservations (action) {
    return this.readZoneReservationData(action).reservations
  }

  getZoneReservationState (action) {
    const data = this.readZoneReservationData(action)
    const ownCount = data.reservations.filter(entry => entry.robotId === this.robotId).length
    const totalCount = data.reservations.length
    return {
      zoneKey: data.zoneKey,
      capacity: data.capacity,
      ownCount,
      otherCount: Math.max(0, totalCount - ownCount),
      totalCount,
      reservations: data.reservations
    }
  }

  getZoneReservation (action) {
    const state = this.getZoneReservationState(action)
    return state.reservations.find(entry => entry.robotId === this.robotId) || state.reservations[0] || null
  }

  reserveZone (action) {
    const data = this.readZoneReservationData(action)
    const now = Date.now()
    const existingIndex = data.reservations.findIndex(entry => entry.robotId === this.robotId)

    if (existingIndex !== -1) {
      data.reservations[existingIndex] = {
        robotId: this.robotId,
        timestamp: now,
        pos: { x: action.pos.x, y: action.pos.y, z: action.pos.z }
      }
      return this.writeZoneReservationData(action, data)
    }

    if (data.reservations.length >= data.capacity) return false

    data.reservations.push({
      robotId: this.robotId,
      timestamp: now,
      pos: { x: action.pos.x, y: action.pos.y, z: action.pos.z }
    })
    return this.writeZoneReservationData(action, data)
  }

  touchZoneReservation (action) {
    const data = this.readZoneReservationData(action)
    const existingIndex = data.reservations.findIndex(entry => entry.robotId === this.robotId)
    if (existingIndex === -1) return false

    data.reservations[existingIndex] = {
      ...data.reservations[existingIndex],
      timestamp: Date.now(),
      pos: { x: action.pos.x, y: action.pos.y, z: action.pos.z }
    }
    return this.writeZoneReservationData(action, data)
  }

  releaseZoneReservation (action) {
    const data = this.readZoneReservationData(action)
    const filtered = data.reservations.filter(entry => entry.robotId !== this.robotId)
    if (filtered.length === data.reservations.length) return
    this.writeZoneReservationData(action, { ...data, reservations: filtered })
  }

  cleanupZoneReservations () {
    try {
      if (!fs.existsSync(this.zoneReservationDir)) return
      const files = fs.readdirSync(this.zoneReservationDir)
      for (const file of files) {
        if (!file.endsWith('.zone')) continue
        const zoneFile = path.join(this.zoneReservationDir, file)
        try {
          const raw = JSON.parse(fs.readFileSync(zoneFile, 'utf8'))
          const normalized = Array.isArray(raw.reservations)
            ? { ...raw, reservations: raw.reservations.filter(entry => entry && entry.robotId !== this.robotId) }
            : (raw.robotId === this.robotId ? { ...raw, reservations: [] } : raw)
          const hasEntries = Array.isArray(normalized.reservations) ? normalized.reservations.length > 0 : Boolean(normalized.robotId)
          if (!hasEntries) fs.unlinkSync(zoneFile)
          else fs.writeFileSync(zoneFile, JSON.stringify(normalized))
        } catch (e) {
          try { fs.unlinkSync(zoneFile) } catch (_) {}
        }
      }
    } catch (e) {}
  }

  static cleanupExpiredZoneReservations () {
    ensureZoneReservationDir()
    try {
      const files = fs.readdirSync(ZONE_RESERVATION_DIR)
      for (const file of files) {
        if (!file.endsWith('.zone')) continue
        const zoneFile = path.join(ZONE_RESERVATION_DIR, file)
        try {
          const reservation = JSON.parse(fs.readFileSync(zoneFile, 'utf8'))
          const now = Date.now()
          let nextReservation = reservation

          if (Array.isArray(reservation.reservations)) {
            nextReservation = {
              ...reservation,
              reservations: reservation.reservations.filter(entry => entry && entry.robotId && entry.timestamp && now - entry.timestamp <= ZONE_RESERVATION_TTL_MS)
            }
            if (nextReservation.reservations.length === 0) fs.unlinkSync(zoneFile)
            else fs.writeFileSync(zoneFile, JSON.stringify(nextReservation))
            continue
          }

          if (!reservation.timestamp || now - reservation.timestamp > ZONE_RESERVATION_TTL_MS) {
            fs.unlinkSync(zoneFile)
          }
        } catch (e) {
          try { fs.unlinkSync(zoneFile) } catch (_) {}
        }
      }
    } catch (e) {}
  }

  // 锁定一个动作
  lockAction (action) {
    const key = this.getLockKey(action)
    const lockFile = path.join(this.lockDir, `${key}.lock`)
    const lockData = {
      robotId: this.robotId,
      timestamp: Date.now(),
      type: action.type,
      pos: { x: action.pos.x, y: action.pos.y, z: action.pos.z }
    }

    try {
      const fd = fs.openSync(lockFile, 'wx')
      fs.writeFileSync(fd, JSON.stringify(lockData))
      fs.closeSync(fd)
      return true
    } catch (e) {
      if (e.code === 'EEXIST') {
        try {
          const existing = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
          if (existing.robotId === this.robotId) {
            fs.writeFileSync(lockFile, JSON.stringify(lockData))
            return true
          }

          if (Date.now() - existing.timestamp > LOCK_TTL_MS) {
            fs.unlinkSync(lockFile)
            return this.lockAction(action)
          }
        } catch (readErr) {
          try {
            fs.unlinkSync(lockFile)
            return this.lockAction(action)
          } catch (_) {}
        }
        return false
      }

      console.error(`Failed to lock action ${key}:`, e.message)
      return false
    }
  }

  touchActionLock (action) {
    const key = this.getLockKey(action)
    const lockFile = path.join(this.lockDir, `${key}.lock`)
    try {
      if (!fs.existsSync(lockFile)) return false
      const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      if (lockData.robotId !== this.robotId) return false
      lockData.timestamp = Date.now()
      fs.writeFileSync(lockFile, JSON.stringify(lockData))
      return true
    } catch (e) {
      return false
    }
  }

  // 解锁一个动作
  unlockAction (action) {
    const key = this.getLockKey(action)
    const lockFile = path.join(this.lockDir, `${key}.lock`)
    try {
      if (fs.existsSync(lockFile)) {
        const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
        // 只解锁自己锁定的任务
        if (lockData.robotId === this.robotId) {
          fs.unlinkSync(lockFile)
        }
      }
    } catch (e) {
      // 忽略解锁错误
    }
  }

  // 检查动作是否被锁定
  isActionLocked (action) {
    const key = this.getLockKey(action)
    const lockFile = path.join(this.lockDir, `${key}.lock`)
    if (!fs.existsSync(lockFile)) {
      return false
    }
    try {
      const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
      // 检查锁是否过期（超过180秒视为过期）
      if (Date.now() - lockData.timestamp > LOCK_TTL_MS) {
        fs.unlinkSync(lockFile)
        return false
      }
      // 如果是自己锁定的，不算被锁定
      return lockData.robotId !== this.robotId
    } catch (e) {
      return false
    }
  }

  // 清理所有本机器人的锁
  cleanupLocks () {
    try {
      if (!fs.existsSync(this.lockDir)) return
      const files = fs.readdirSync(this.lockDir)
      for (const file of files) {
        if (file.endsWith('.lock')) {
          const lockFile = path.join(this.lockDir, file)
          try {
            const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
            if (lockData.robotId === this.robotId) {
              fs.unlinkSync(lockFile)
            }
          } catch (e) {
            // 忽略错误
          }
        }
      }
    } catch (e) {
      console.error('Failed to cleanup locks:', e.message)
    }
    this.cleanupZoneReservations()
  }

  // 清理所有过期的锁
  static cleanupExpiredLocks () {
    ensureLockDir()
    ensureZoneReservationDir()
    const lockDir = LOCK_DIR
    try {
      const files = fs.readdirSync(lockDir)
      for (const file of files) {
        if (file.endsWith('.lock')) {
          const lockFile = path.join(lockDir, file)
          try {
            const lockData = JSON.parse(fs.readFileSync(lockFile, 'utf8'))
            // 清理超过180秒的过期锁
            if (Date.now() - lockData.timestamp > LOCK_TTL_MS) {
              fs.unlinkSync(lockFile)
            }
          } catch (e) {
            // 文件损坏，直接删除
            try {
              fs.unlinkSync(lockFile)
            } catch (e2) {
              // 忽略
            }
          }
        }
      }
    } catch (e) {
      console.error('Failed to cleanup expired locks:', e.message)
    }

    Build.cleanupExpiredZoneReservations()
  }

  getAvailableActions (options = {}) {
    const { exactProperties = true, includeLocked = false } = options

    return this.actions.filter(action => {
      if (!includeLocked && this.isActionLocked(action)) return false
      if (this.isActionSatisfied(action, this.world.getBlock(action.pos), { exactProperties })) return false
      if (action.type === 'dig') return true
      if (exactProperties && this.canInteractToMatch(action, this.world.getBlock(action.pos))) return true
      return this.hasLiveReference(action.state, action.pos)
    })
  }
}

module.exports = Build
