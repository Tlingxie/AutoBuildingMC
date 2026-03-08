# AutoBuildingMC

一个基于 `mineflayer` 的多机器人自动建造项目，支持读取 `schematic/litematic` 结构文件，并让多个 bot 协同完成搭建。

这个仓库基于 `PrismarineJS/mineflayer-builder` 继续修改，重点增强了多 bot 协作、飞行避障、残局分配和后期卡住恢复能力。

## 功能特点

- 多机器人协同建造
- 两阶段建造：先放对方块类型，再修正朝向/属性
- 创造模式飞行建造
- 飞行时使用 3D A* 进行障碍规避
- 短锁 + 区域预约，降低多 bot 抢同一位置的冲突
- 后期卡住检测与自动重定位
- 支持公开 `schematics` 目录中的结构文件

## 仓库结构

- `index.js`：builder 主逻辑
- `lib/Build.js`：动作生成、锁、区域预约、状态匹配
- `examples/multiBuilder.js`：多 bot 启动器
- `examples/workerBot.js`：单个 bot 工作进程
- `schematics`：结构文件

## 环境要求

- Node.js 18+
- 一个 Minecraft Java 版服务器
- bot 需要有较高权限，建议满足以下条件：
  - 能使用 `/gamemode creative`
  - 能获得建筑材料
  - 能使用 `/clear`
- 推荐在平坦世界或可自由飞行的测试服中使用

## 安装

```bash
git clone https://github.com/Tlingxie/AutoBuildingMC.git
cd AutoBuildingMC
npm install
```

## 快速开始

### 单机器人示例

如果你想先验证 builder 是否能工作，可以运行：

```bash
node examples/builder.js
```

### 多机器人建造

仓库已经提供多 bot 启动脚本：

```bash
npm run multi-build
```

开发时也可以直接指定参数：

```bash
node examples/multiBuilder.js <host> <port> <botCount> <usernamePrefix> <flight>
```

例如：

```bash
node examples/multiBuilder.js localhost 25565 20 builder true
```

或者：

```bash
npm run multi-build:dev
```

## 参数说明

`examples/multiBuilder.js` 支持以下参数：

- `host`：服务器地址，默认 `localhost`
- `port`：服务器端口，默认 `25565`
- `botCount`：bot 数量，默认 `20`
- `usernamePrefix`：bot 名前缀，默认 `builder`
- `flight`：是否启用飞行，默认 `true`

## 默认结构文件

当前 `examples/workerBot.js` 默认读取：

- `schematics/smallhouse1.schem`

如果你想替换成其他结构文件，可以修改：

- `examples/workerBot.js`

仓库中目前公开的结构文件包括：

- `schematics/smallhouse1.schem`
- `schematics/FDragonSTv2-119.schem`
- `schematics/_2024.schem`
- `schematics/海上别墅2024.litematic`

## 当前实现重点

这个版本相较于上游，主要增加了以下行为：

- 更可靠的动作移除与状态满足判断
- 活板门、墙、楼梯等动态属性的延后修正
- 先类型、后属性的建造流程
- 放置时实时检查相邻支撑块
- 飞行 fallback 使用 A* 避障，而不是直接直线飞过去
- 多 bot 后期的锁恢复、重分配和反挂机恢复

## 已知限制

- `examples/workerBot.js` 当前默认结构文件路径是写死的，需要手动修改
- 依赖 Minecraft 服务端环境，无法在纯离线环境验证真实建造效果
- 复杂结构在不同版本方块状态下，仍可能需要针对性调参
- 仓库目前仍有一些历史格式问题，`npm test` 可能报告 `standard` 风格告警

## 开发说明

语法检查可用：

```bash
node --check index.js
node --check lib/Build.js
node --check examples/multiBuilder.js
node --check examples/workerBot.js
```

## 致谢

- 上游项目：`PrismarineJS/mineflayer-builder`
- 相关生态：`mineflayer`、`mineflayer-pathfinder`、`prismarine-schematic`

## License

MIT
