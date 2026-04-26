# 温室大棚物联网管理系统 — 详细使用手册

> 本手册涵盖项目部署、配置、运维的全部细节。

---

## 目录

1. [系统概述](#1-系统概述)
2. [服务器部署](#2-服务器部署)
3. [OneNET 平台配置](#3-onenet-平台配置)
4. [微信小程序配置](#4-微信小程序配置)
5. [硬件设备接线](#5-硬件设备接线)
6. [功能详解](#6-功能详解)
7. [运维指南](#7-运维指南)
8. [常见问题](#8-常见问题)

---

## 1. 系统概述

### 1.1 系统组成

| 组件 | 技术栈 | 说明 |
|------|--------|------|
| 后端服务 | Node.js + Express | REST API + WebSocket 服务 |
| 数据库 | SQLite (WAL模式) | 传感器数据、操作日志 |
| 通信平台 | OneNET IoT | 设备接入与指令下发 |
| 前端 | 微信小程序 | 用户操作界面 |

### 1.2 支持的设备

系统默认支持 4 个设备，名称固定为:

```
MY4G   → 一号大棚
MY4G2  → 二号大棚
MY4G3  → 三号大棚
MY4G4  → 四号大棚
```

如需修改设备名称或数量，编辑以下文件:
- `微信小程序端/utils/config.js` — 小程序端设备列表
- `wechat-iot-server/server.js` — 后端 `DEVICES_TO_SYNC` 列表

### 1.3 端口说明

| 端口 | 协议 | 用途 |
|------|------|------|
| 8081 | HTTP + WebSocket | 后端服务主端口 |
| 3306 | TCP | MySQL（未使用，本系统用 SQLite）|

---

## 2. 服务器部署

### 2.1 环境要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Ubuntu 18.04+ / Debian 10+ / CentOS 7+ |
| Node.js | 18.x 或更高 |
| SQLite3 | 3.x |
| 内存 | 512MB+ |
| 磁盘 | 2GB+ |

### 2.2 手动安装步骤

#### 第一步: 安装 Node.js

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
sudo apt-get install -y nodejs

# CentOS
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs
```

验证安装:

```bash
node -v   # 应显示 v18.x.x
npm -v    # 应显示 9.x.x
```

#### 第二步: 安装 SQLite3 和编译工具

```bash
# Ubuntu / Debian
sudo apt-get install -y sqlite3 libsqlite3-dev make gcc g++

# CentOS
sudo yum install -y sqlite sqlite-devel make gcc gcc-c++
```

#### 第三步: 安装 PM2

```bash
sudo npm install -g pm2
```

#### 第四步: 部署项目

```bash
# 上传项目到服务器，或:
git clone https://github.com/YOUR_USERNAME/greenhouse-iot-system.git
cd greenhouse-iot-system/wechat-iot-server

# 安装依赖
npm install
```

#### 第五步: 配置 OneNET 凭证

**必须修改** `server.js` 顶部的配置:

```javascript
const ONENET_CONFIG = {
    api_base_url: "https://iot-api.heclouds.com",
    product_id: "这里填入你的产品ID",
    auth_info: "这里填入你的授权信息",
    identifiers: { MOTOR: 'LED' },
};
```

#### 第六步: 启动服务

```bash
# 方式一: 直接运行（用于调试）
node server.js

# 方式二: PM2 守护进程（生产环境）
pm2 start server.js --name wechat-iot

# 配置开机自启
pm2 startup
pm2 save
```

#### 第七步: 配置防火墙

```bash
# Ubuntu (ufw)
sudo ufw allow 8081/tcp

# CentOS (firewalld)
sudo firewall-cmd --permanent --add-port=8081/tcp
sudo firewall-cmd --reload
```

### 2.3 一键安装脚本

如果是全新系统，可直接运行:

```bash
cd wechat-iot-server
chmod +x install.sh
bash install.sh
```

脚本会自动安装: Node.js 18、SQLite3、PM2 及项目依赖。

### 2.4 服务管理命令

```bash
pm2 start wechat-iot          # 启动
pm2 stop wechat-iot           # 停止
pm2 restart wechat-iot        # 重启
pm2 logs wechat-iot           # 查看日志
pm2 monit                      # 监控面板
pm2 save                       # 保存当前进程列表
pm2 startup                    # 配置开机自启
```

---

## 3. OneNET 平台配置

### 3.1 创建产品

1. 登录 [OneNET 开发者中心](https://open.iot.10086.cn/)
2. 进入**多协议设备**产品
3. 点击**创建产品**，填写信息:
   - 产品名称: `温室大棚`
   - 设备接入协议: 选择你的设备支持的协议
   - 校验方式: 填写设备秘钥或 Token

### 3.2 创建设备

在产品下创建 4 个设备:

| 设备名称 | 备注 |
|---------|------|
| MY4G | 一号大棚 |
| MY4G2 | 二号大棚 |
| MY4G3 | 三号大棚 |
| MY4G4 | 四号大棚 |

记录每个设备的:
- **设备名称** (device_name)
- **产品ID** (product_id)
- **设备秘钥** 或 **Token**

### 3.3 定义物模型（属性）

在 OneNET 产品中定义以下数据属性:

| 属性标识 | 名称 | 数据类型 | 单位 | 说明 |
|---------|------|---------|------|------|
| Temp | 空气温度 | float | ℃ | 1号传感器 |
| Humi | 空气湿度 | float | % | 1号传感器 |
| Lux | 光照强度 | float | Lux | 光照传感器 |
| Humi1 | 土壤湿度 | float | % | 2号传感器 |
| Temp1 | 土壤温度 | float | ℃ | 2号传感器 |
| Ec | 电导率 | float | μS/cm | EC传感器 |
| motor1 | 电机A状态 | string | - | 1=开运行,2=开停止,3=关运行,4=关停止 |
| motor2 | 电机B状态 | string | - | 同上 |
| LED | 控制指令 | string | - | 由服务器下发控制指令 |

### 3.4 获取 API 凭证

#### 获取 Product ID

在产品详情页可见。

#### 获取 Auth Info (Token)

进入**产品概览** → **设备接全** → 查看校验方式对应的 Token。

**注意**: Token 有有效期，过期后需刷新。OneNET 控制台可查看当前 Token。

---

## 4. 微信小程序配置

### 4.1 修改配置项

#### utils/config.js

```javascript
const config = {
    // OneNET 凭证 — 必须修改
    auth_info: "YOUR_AUTH_INFO",
    product_id: "YOUR_PRODUCT_ID",
    api_base_url: "https://iot-api.heclouds.com",

    // 服务器地址 — 必须修改为你的服务器 IP
    server_base_url: "http://你的服务器IP:8081",
    web_url: "http://你的服务器IP:8081",
};
```

#### pages/index/index.js

```javascript
// ⚠️ 改为你的服务器地址
const WS_URL = 'ws://你的服务器IP:8081';
```

#### project.config.json

```json
{
    "appid": "你的小程序AppID"
}
```

### 4.2 修改设备名称（如需）

编辑 `utils/config.js` 中的 devices 数组:

```javascript
const devices = [
    { name: "一号大棚", deviceName: "MY4G" },
    { name: "二号大棚", deviceName: "MY4G2" },
    // ...
];
```

同时修改后端 `server.js` 中的 `DEVICE_CONFIGS` 和 `DEVICES_TO_SYNC`。

### 4.3 修改电机时间参数

每个设备的 timeA / timeB 代表电机从 0% 到 100% 的完整行程时间（毫秒）:

```javascript
const DEVICE_CONFIGS = {
    "MY4G": { timeA: 275000, timeB: 200000 }, // A=上通风口, B=下通风口
    "MY4G2": { timeA: 275000, timeB: 200000 },
    // ...
};
```

**如何获取此数值**: 记录通风口从全关到全开（或全开到全关）的实际时间，转换为毫秒填入。

### 4.4 修改控制指令

如果硬件通讯协议不同，修改 `COMMANDS_MAP`:

```javascript
const COMMANDS_MAP = {
    A: {  // 电机A (上通风口)
        forward: { start: 'AA12G', stop: 'BB12G', runState: '3', stopState: '4' }, // 关
        reverse: { start: 'CC12G', stop: 'DD12G', runState: '1', stopState: '2' }  // 开
    },
    B: {  // 电机B (下通风口)
        forward: { start: 'EE12G', stop: 'FF12G', runState: '3', stopState: '4' }, // 关
        reverse: { start: 'GG12G', stop: 'HH12G', runState: '1', stopState: '2' }  // 开
    }
};
```

| 字段 | 说明 |
|------|------|
| start | 启动指令 |
| stop | 停止指令 |
| runState | 运行时物理状态码（用于判断电机是否已启动）|
| stopState | 停止时物理状态码 |

### 4.5 发布小程序

1. 在微信公众平台创建小程序，获取 AppID
2. 用微信开发者工具导入 `微信小程序端` 目录
3. 修改上述配置
4. 在开发者工具中点击**上传**
5. 在 [微信公众平台](https://mp.weixin.qq.com/) 提交审核并发布

---

## 5. 硬件设备接线

### 5.1 设备清单（参考）

| 设备 | 型号/规格 | 数量 |
|------|----------|------|
| 主控 | 4G DTU 或 ESP8266/ESP32 | 4套 |
| 温湿度传感器 | DHT22 或 SHT20 | 8个 |
| 光照传感器 | BH1750 | 4个 |
| 土壤传感器 | Capacitive Soil Moisture v1.2 | 4个 |
| EC传感器 | DFR0300 | 4个 |
| 直流电机 | 12V 减速电机 | 8个 |
| 电机驱动 | L298N 或 TB6612FNG | 8个 |

### 5.2 4G DTU 配置（参考）

设备通过 4G DTU 连接到 OneNET，使用 MQTT 或 HTTP 协议:

```
设备 → (RS485/Modbus) → 4G DTU → OneNET → 本系统 → 小程序
```

DTU 端需要:
1. 配置 OneNET 产品 ID 和设备名称
2. 配置上报周期（建议 30s~60s 上报一次）
3. 确保物模型属性与 OneNET 平台定义一致

---

## 6. 功能详解

### 6.1 看门狗机制

系统内置两层看门狗:

**启动看门狗** (`runStartWatchdog`):
- 用户发送启动指令后，每 10 秒检测一次电机物理状态
- 最多重试 10 次（100 秒超时）
- 确认电机启动后才进入倒计时停止阶段

**停止看门狗** (`runStopWatchdog`):
- 倒计时结束后，发送停止指令
- 每 10 秒检测一次是否已停止
- 最多重试 10 次，确保电机可靠停止

### 6.2 服务器重启恢复

服务器意外重启后，`restoreInterruptedTasks()` 会:
1. 读取 `motor_tasks` 表中未完成的任务
2. 判断任务是否已过期（超过预计停止时间）:
   - 已过期 → 立即执行停止逻辑
   - 进行中 → 恢复定时器继续执行
3. 确保没有电机在无人看管状态下运行

### 6.3 兜底机制

每小时整点执行一次 `runFailsafeStopRoutine`，依次发送:
```
BB12G → DD12G → FF12G → HH12G
```
每次间隔 60 秒。用于防止指令丢失导致电机一直运行。

### 6.4 操作日志

所有操作记录在 `command_logs` 表中:

| 字段 | 说明 |
|------|------|
| timestamp | 操作时间 |
| ip | 操作来源 IP |
| deviceName | 设备名称 |
| action | 操作类型（启动指令/停止指令/强制校准）|
| details | 详细描述 |

日志默认保留 30 天自动清理。

---

## 7. 运维指南

### 7.1 备份

```bash
# 备份数据库
cp greenhouse_data.db greenhouse_data.db.backup.$(date +%Y%m%d)

# 备份整个项目
tar -czf backup_$(date +%Y%m%d).tar.gz wechat-iot-server/
```

### 7.2 恢复

```bash
# 停止服务
pm2 stop wechat-iot

# 恢复数据库
cp greenhouse_data.db.backup.20240101 greenhouse_data.db

# 重启服务
pm2 restart wechat-iot
```

### 7.3 更新

```bash
cd wechat-iot-server
git pull  # 拉取新版本（如果使用 git 管理）

# 重新安装依赖（如果 package.json 有变化）
npm install

# 重启服务
pm2 restart wechat-iot
```

### 7.4 日志管理

```bash
# 查看实时日志
pm2 logs wechat-iot --f

# 查看最近 100 行日志
pm2 logs wechat-iot --lines 100

# 清空日志文件
pm2 flush
```

### 7.5 数据库清理

数据默认保留 3 个月，超期自动清理。如需手动清理:

```bash
sqlite3 greenhouse_data.db "DELETE FROM sensor_data WHERE timestamp < datetime('now', '-90 days');"
sqlite3 greenhouse_data.db "DELETE FROM command_logs WHERE timestamp < datetime('now', '-30 days');"
sqlite3 greenhouse_data.db "VACUUM;"  # 压缩数据库
```

---

## 8. 常见问题

### Q1: 电机发出指令但不动作

**可能原因**:
1. 设备不在线 — 检查 4G DTU 电源和信号
2. 指令格式不对 — 核对 `COMMANDS_MAP` 与硬件协议
3. OneNET 凭证错误 — 确认 product_id 和 auth_info 正确
4. 网络延迟 — 等待看门狗重试（最多 100 秒）

**排查步骤**:
```bash
# 检查设备在线状态
curl "https://iot-api.heclouds.com/device/detail?product_id=YOUR_ID&device_name=MY4G" \
  -H "Authorization: YOUR_AUTH"

# 查看服务端日志
pm2 logs wechat-iot
```

### Q2: 小程序提示"设备不在线"

1. 确认 OneNET 控制台中设备状态为"在线"
2. 检查 `server_base_url` 是否填写正确（不要有空格或多余字符）
3. 确认服务器防火墙放行了 8081 端口

### Q3: 传感器数据显示"N/A"

1. 确认设备已通过 DTU 上报到 OneNET
2. 确认物模型中属性标识符与代码一致（大小写敏感）
3. 等待下一次数据上报周期（10分钟）

### Q4: WebSocket 连接失败

微信小程序要求 WebSocket 使用 **wss**（如果服务器配置了 SSL）或直连模式:

```javascript
// 无 SSL 情况（开发/内网）:
const WS_URL = 'ws://YOUR_SERVER_IP:8081';

// 有 SSL 情况（生产环境）:
const WS_URL = 'wss://YOUR_DOMAIN.COM'
```

### Q5: 服务器重启后电机状态丢失

正常现象。`motor_positions` 表记录最后位置，但内存状态需等待下一次轮询恢复。约 2 秒后自动同步。

### Q6: 通风口位置不准确

1. **重新校准**: 在控制页面点击"设为全关(0%)"或"设为全开(100%)"
2. **调整行程时间**: 修改 `DEVICE_CONFIGS` 中的 `timeA` / `timeB`（毫秒）

---

## 附录: API 参考

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/devices` | GET | 获取设备列表 |
| `/api/get-motor-states` | GET | 获取电机状态 |
| `/api/start-timed-motor` | POST | 启动定时电机 |
| `/api/stop-motor` | POST | 停止电机 |
| `/api/set-motor-position` | POST | 校准电机位置 |
| `/api/data` | GET | 查询传感器数据 |
| `/api/export` | GET | 导出 CSV 数据 |
| `/api/logs` | GET | 查询操作日志 |

WebSocket: 连接 `ws://YOUR_SERVER:8081`，接收 `motorStates` 类型消息。
