# 🌿 温室大棚物联网管理系统

一套基于微信小程序 + Node.js 后端的温室大棚远程监控系统。支持多设备管理、通风口电机控制、传感器数据采集、WebSocket 实时状态推送等功能。

[English](README_en.md) | 中文

---

## 功能特性

- **多设备管理** — 同时管理 4 个大棚设备
- **实时监控** — 温度、湿度、光照、土壤 EC 等传感器数据
- **电机控制** — 远程控制上下通风口电机，支持定时运行
- **WebSocket 实时推送** — 电机状态变化实时同步到小程序
- **操作日志** — 所有控制操作均有记录，可追溯
- **数据导出** — 支持 CSV 格式导出历史数据
- **服务器重启恢复** — 意外重启后自动恢复中断的电机任务
- **看门狗机制** — 确保指令可靠执行，自动重试

---

## 微信小程序端界面展示
<img width="347" height="776" alt="image" src="https://github.com/user-attachments/assets/6364bdb4-1a73-4b1d-9518-fb64b35c2ed9" />
<img width="348" height="769" alt="image" src="https://github.com/user-attachments/assets/c70dcf4d-58dd-46d0-ae60-7fd1bcbd3fba" />
<img width="353" height="773" alt="image" src="https://github.com/user-attachments/assets/4abaab86-695d-4687-a103-8bec175e2439" />
## 网页端界面展示
<img width="955" height="955" alt="image" src="https://github.com/user-attachments/assets/389df5bb-7d01-4f59-8afe-18c713b64cb2" />
<img width="955" height="955" alt="image" src="https://github.com/user-attachments/assets/214e2832-6809-4420-8d46-f873778d2ccd" />

## 系统架构

```
┌─────────────────────────────────────────────────────────┐
│                    微信小程序端                           │
│   pages/overview (总览)  pages/index (控制)              │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP / WebSocket
                       ▼
┌──────────────────────────────────────────────────────────┐
│              Node.js 后端服务 (端口 8081)                  │
│   Express + SQLite + WebSocket + node-cron              │
│   - 传感器数据采集   - 电机控制指令  - 状态推送            │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTPS API
                       ▼
┌──────────────────────────────────────────────────────────┐
│                    OneNET IoT 平台                        │
│   https://iot-api.heclouds.com                          │
│   - 设备注册    - 属性查询    - 指令下发                  │
└──────────────────────────────────────────────────────────┘
```

---

## 快速开始

### 前置要求

- Node.js 18+
- npm / yarn
- SQLite3
- 微信小程序开发者工具
- [OneNET 物联网平台](https://open.iot.10086.cn/) 账号

### 1. 克隆项目

```bash
git clone https://github.com/YOUR_USERNAME/greenhouse-iot-system.git
cd greenhouse-iot-system
```

### 2. 配置后端服务

```bash
cd wechat-iot-server

# 编辑配置文件，填入你的 OneNET 信息
# ⚠️ 必须修改以下几处:
#   - server.js: ONENET_CONFIG.product_id / auth_info
#   - config.js: server_base_url / web_url
#   - index.js: WS_URL

npm install
```

### 3. 启动后端服务

```bash
# 方式一: 直接运行（开发模式）
node server.js

# 方式二: PM2 守护进程（生产环境推荐）
bash install.sh   # 首次安装
bash start.sh     # 启动服务
```

服务监听端口 **8081**，确保服务器防火墙放行该端口。

### 4. 配置微信小程序

```bash
cd ../微信小程序端

# 编辑 utils/config.js，填入:
#   - auth_info: OneNET 授权信息
#   - product_id: OneNET 产品 ID
#   - server_base_url: 你的服务器地址
#   - web_url: 你的数据展示网页地址

# 编辑 pages/index/index.js 中的 WS_URL
# 编辑 project.config.json 中的 appid 为你的小程序 AppID
```

用微信开发者工具导入 `微信小程序端` 目录即可。

---

## 目录结构

```
greenhouse-iot-system/
├── README.md
├── LICENSE
├── .gitignore
│
├── wechat-iot-server/          # Node.js 后端服务
│   ├── server.js                # 主服务文件 (~970行)
│   ├── package.json
│   ├── install.sh               # 一键安装脚本
│   ├── start.sh                 # 启动脚本
│   ├── restart.sh               # 重启脚本
│   └── greenhouse_data.db      # SQLite 数据库（自动生成）
│
├── 微信小程序端/                 # 微信小程序源码
│   ├── app.js / app.json       # 全局入口
│   ├── project.config.json     # 项目配置（需填入 AppID）
│   ├── pages/
│   │   ├── overview/           # 总览页（设备状态卡片）
│   │   ├── index/              # 控制中心页（电机控制）
│   │   └── webview/            # 数据图表页
│   └── utils/
│       ├── config.js           # ⚠️ 配置文件（需填入信息）
│       └── util.js             # 通用工具函数
│
└── docs/
    └── MANUAL.md               # 详细使用手册
```

---

## 电机控制说明

每个设备有 **A（上通风口）** 和 **B（下通风口）** 两个电机：

| 方向 | 启动指令 | 停止指令 | 说明 |
|------|---------|---------|------|
| 正转(关) | AA12G / EE12G | BB12G / FF12G | 通风口关闭 |
| 反转(开) | CC12G / GG12G | DD12G / HH12G | 通风口打开 |

> 如果硬件指令不同，请修改 `COMMANDS_MAP` 配置。

---

## OneNET 平台配置

1. 登录 [OneNET 开发者中心](https://open.iot.10086.cn/)
2. 创建**多协议设备**产品
3. 在产品下创建设备（如 MY4G, MY4G2 等，名称需与代码中一致）
4. 获取 **Product ID** 和 **认证信息（API Key / Token）**
5. 在产品模型中定义以下属性:
   - `Temp` — 空气温度
   - `Humi` — 空气湿度
   - `Lux` — 光照强度
   - `Humi1` — 土壤湿度
   - `Temp1` — 土壤温度
   - `Ec` — 电导率
   - `motor1` — 电机A状态
   - `motor2` — 电机B状态
   - `LED` — 控制指令下发（类型：string）

---

## 环境变量 / 配置参考

后端服务支持通过环境变量配置（可选）:

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `PORT` | HTTP 服务端口 | `8081` |
| `DB_PATH` | SQLite 数据库路径 | `./greenhouse_data.db` |

---

## License

MIT License — 详见 [LICENSE](LICENSE) 文件。
