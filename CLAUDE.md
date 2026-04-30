# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Greenhouse IoT Management System (温室大棚物联网管理系统) — a WeChat Mini Program + Node.js backend for remote greenhouse monitoring and control via the OneNET IoT platform.

## Architecture

Three-tier system:

```
WeChat Mini Program  <--HTTP + WebSocket-->  Node.js Server  <--HTTPS-->  OneNET IoT Platform
```

- **Backend** (`wechat-iot-server/server.js`): Monolithic single-file (~970 lines). Express REST API + WebSocket (ws) + SQLite (WAL mode) + node-cron. Communicates with OneNET via axios.
- **Frontend** (`微信小程序端/`): WeChat Mini Program with 3 pages — overview (device status cards), index (motor control with WebSocket), webview (Chart.js dashboard embedded from server).
- **Web Dashboard** (`wechat-iot-server/public/index.html`): Chart.js-based data visualization, served as static assets by Express.

Motor states are tracked in-memory (`motorStates` object) with SQLite backup. A watchdog mechanism retries commands up to 10 times at 10s intervals. Interrupted motor tasks survive server restarts via `restoreInterruptedTasks()`.

## Commands

```bash
cd wechat-iot-server
npm install                    # Install dependencies
node server.js                 # Dev mode (port 8081)
bash start.sh                  # Production (PM2: pm2 start server.js --name wechat-iot)
bash restart.sh                # PM2 restart
```

No test suite exists. Environment variables: `PORT` (default 8081), `DB_PATH` (default `./greenhouse_data.db`).

Mini program: open `微信小程序端` in WeChat Developer Tools.

## Configuration Placeholders (must replace before deployment)

- `wechat-iot-server/server.js`: `ONENET_CONFIG.product_id`, `ONENET_CONFIG.auth_info`
- `微信小程序端/utils/config.js`: `auth_info`, `product_id`, `server_base_url`, `web_url`
- `微信小程序端/pages/index/index.js`: `WS_URL`
- `微信小程序端/project.config.json`: `appid`

## Key Domain Concepts

Each greenhouse device (MY4G, MY4G2, MY4G3, MY4G4) has two motors: A (upper vent) and B (lower vent). Motor commands are hex strings mapped in `COMMANDS_MAP` — forward = close vent, reverse = open vent. `DEVICE_CONFIGS` defines per-device motor run durations.

OneNET properties: `Temp`, `Humi`, `Lux` (light), `Humi1` (soil moisture), `Temp1` (soil temp), `Ec` (conductivity), `motor1`/`motor2` (motor state codes 1-4).

## Database

SQLite with WAL mode. Tables: `sensor_data`, `motor_positions`, `motor_tasks`, `command_logs`. DB file is auto-generated at `greenhouse_data.db`.
