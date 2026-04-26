// server.js

// --- 基础依赖 ---
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { Parser } = require('json2csv');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');

// --- 基础配置 ---
const ONENET_CONFIG = {
    api_base_url: "https://iot-api.heclouds.com",
    product_id: "YOUR_PRODUCT_ID",
    auth_info: "YOUR_AUTH_INFO",
    identifiers: { MOTOR: 'LED' },
};

const DB_CONFIG = { db_path: './greenhouse_data.db' };

// --- 【新增】看门狗配置 ---
const WATCHDOG_CONFIG = {
    MAX_RETRIES: 10,       // 最大重试次数 (10次 x 10秒 = 100秒超时)
    INTERVAL_MS: 10000,    // 每次检查/重发的间隔 (10秒)
};

// 设备配置表
const DEVICE_CONFIGS = {
    "MY4G": { timeA: 275000, timeB: 200000 },
    "MY4G2": { timeA: 275000, timeB: 200000 },
    "MY4G3": { timeA: 275000, timeB: 200000 },
    "MY4G4": { timeA: 275000, timeB: 210000 }
};

const DEVICES_TO_SYNC = Object.keys(DEVICE_CONFIGS);

// 指令映射表
// runState: 期望的运行物理状态码 (1:开运行, 3:关运行)
// stopState: 期望的停止物理状态码 (2:开停止, 4:关停止)
const COMMANDS_MAP = {
    A: { 
        forward: { start: 'AA12G', stop: 'BB12G', runState: '3', stopState: '4' }, // 关
        reverse: { start: 'CC12G', stop: 'DD12G', runState: '1', stopState: '2' }  // 开
    },
    B: { 
        forward: { start: 'EE12G', stop: 'FF12G', runState: '3', stopState: '4' }, // 关
        reverse: { start: 'GG12G', stop: 'HH12G', runState: '1', stopState: '2' }  // 开
    }
};

const POLL_INTERVAL_MS = 2000; // 状态轮询间隔 (用于更新 internal motorStates)

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const activeTimers = {};
let globalCooldownUntil = 0;
const POST_RUN_COOLDOWN = 10000;

// 全局电机状态跟踪器
const motorStates = {};

// --- 数据库初始化 ---
const db = new sqlite3.Database(DB_CONFIG.db_path, (err) => {
    if (err) { console.error('❌ 连接 SQLite 数据库失败:', err.message); process.exit(1); }
    console.log('✅ 成功连接到 SQLite 数据库');
});

db.serialize(() => {
    // 开启 WAL 模式，大幅提升并发性能
    db.run("PRAGMA journal_mode = WAL;", (err) => {
        if (err) console.error("❌ 开启 WAL 模式失败:", err.message);
        else console.log("✅ SQLite WAL 模式已开启");
    });

    db.run(`CREATE TABLE IF NOT EXISTS sensor_data (deviceName TEXT NOT NULL, identifier TEXT NOT NULL, timestamp TEXT NOT NULL, value REAL NOT NULL, UNIQUE(deviceName, identifier, timestamp))`);
    
    // 存储最后位置
    db.run(`CREATE TABLE IF NOT EXISTS motor_positions (key TEXT PRIMARY KEY, position REAL NOT NULL)`);

    // 创建活动任务表，用于服务器重启后的恢复
    db.run(`CREATE TABLE IF NOT EXISTS motor_tasks (
        key TEXT PRIMARY KEY, 
        deviceName TEXT, 
        motor TEXT, 
        stopCmd TEXT, 
        expectedStopTime INTEGER
    )`, (err) => {
        if (!err) {
            console.log("✅ 数据表 'motor_tasks' 准备就绪。");
            initServerState();
        } else {
             console.error("❌ 创建数据表 'motor_tasks' 失败:", err.message); process.exit(1);
        }
    });
    // --- 【新增日志步骤 1】创建操作日志表 ---
    db.run(`CREATE TABLE IF NOT EXISTS command_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT,
        ip TEXT,
        deviceName TEXT,
        action TEXT,
        details TEXT
    )`, (err) => {
        if (err) console.error("❌ 创建日志表失败:", err.message);
        else console.log("✅ 数据表 'command_logs' 准备就绪");
    });
});

// --- 【新增】放在代码开头区域 ---
function getLogTime() {
    const now = new Date();
    // 生成格式: 2024-12-17 12:30:05
    return now.toLocaleString('zh-CN', { hour12: false });
}

// --- 【新增日志步骤2】写入日志的辅助函数 ---
function logUserAction(req, deviceName, action, details) {
    // 尝试获取真实IP (兼容反向代理和直连)
    let ip = 'System'; // 默认为系统自动执行
    if (req) {
        ip = req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress || 'Unknown';
        if (ip.startsWith('::ffff:')) {
            ip = ip.substr(7); // 去除IPv6前缀，只保留IPv4
        }
    }
    
    const timestamp = new Date().toISOString();
    
    const stmt = db.prepare("INSERT INTO command_logs (timestamp, ip, deviceName, action, details) VALUES (?, ?, ?, ?, ?)");
    stmt.run(timestamp, ip, deviceName, action, details, (err) => {
        if (err) console.error(`[LOG] ❌ 写入日志失败:`, err.message);
        else console.log(`[LOG] 📝 [${ip}] ${deviceName} - ${action}: ${details}`);
    });
    stmt.finalize();
}


// 初始化逻辑封装
function initServerState() {
    console.log("... 初始化服务器状态 ...");
    loadMotorStatesFromDB(); // 加载位置
    restoreInterruptedTasks(); // 恢复中断的任务
    
    setTimeout(() => { 
        console.log("... 启动定时任务 ..."); 
        cleanOldData(); 
        scheduleJobs();
        startProgressPolling();
    }, 1000);
}

// --- 核心恢复逻辑：服务器重启后检查是否有未完成的任务 ---
function restoreInterruptedTasks() {
    console.log('[RECOVERY] 正在检查异常中断的任务...');
    db.all("SELECT * FROM motor_tasks", (err, rows) => {
        if (err) {
            console.error('[RECOVERY] ❌ 读取任务表失败:', err.message);
            return;
        }
        if (rows.length === 0) {
            console.log('[RECOVERY] ✅ 没有中断的任务');
            return;
        }

        const now = Date.now();
        rows.forEach(task => {
            const { deviceName, motor, stopCmd, expectedStopTime } = task;
            const motorKey = `motor${motor}`;
            const remainingTime = expectedStopTime - now;
            const timerKey = `${deviceName}-${motor}`;

            console.log(`[RECOVERY] 发现任务: ${deviceName} 电机${motor}, 预计停止时间: ${new Date(expectedStopTime).toLocaleString()}`);

            if (remainingTime <= 0) {
                // 情况1: 服务器挂太久了，这个任务本该在过去就停止
                console.warn(`[RECOVERY] ⚠️ 任务已过期! 立即执行停止逻辑: ${stopCmd}`);
                handleStopMotorLogic(deviceName, motorKey, stopCmd);
            } else {
                // 情况2: 任务还在进行中，恢复定时器
                console.log(`[RECOVERY] ♻️ 恢复任务，将在 ${remainingTime / 1000} 秒后停止`);
                
                // 恢复 activeTimers
                const timeoutId = setTimeout(() => {
                    console.log(`[TIMER-RESTORED] ${deviceName}-${motor} 自动停止时间到。`);
                    handleStopMotorLogic(deviceName, motorKey, stopCmd);
                }, remainingTime);

                activeTimers[timerKey] = { timeoutId, stopCmd };
                
                // 临时恢复内存状态
                if (motorStates[deviceName] && motorStates[deviceName][motorKey]) {
                    motorStates[deviceName][motorKey].logicalState = 'running';
                }
            }
        });
    });
}

function savePositionToDB(deviceName, motorChar, position) {
    const dbKey = `${deviceName}-${motorChar}`;
    const finalPosition = parseFloat(position.toFixed(4));
    db.run("REPLACE INTO motor_positions (key, position) VALUES (?, ?)", [dbKey, finalPosition], (err) => {
        if (err) console.error(`[STATE] ❌ 数据库保存 ${dbKey} 最终位置失败:`, err.message);
    });
}

function loadMotorStatesFromDB() {
    console.log('[STATE] 正在从数据库加载电机最后位置...');
     for (const deviceName of DEVICES_TO_SYNC) {
        if (!motorStates[deviceName]) motorStates[deviceName] = {};
        const keys = [`${deviceName}-A`, `${deviceName}-B`];
        const motorKeys = ['motorA', 'motorB'];
        keys.forEach((key, index) => {
            const motorKey = motorKeys[index];
            db.get("SELECT position FROM motor_positions WHERE key = ?", [key], (err, row) => {
                let position = 100.0; 
                if (err) console.error(`[STATE] ❌ 加载 ${key} 位置失败:`, err.message);
                if (row) {
                    position = row.position;
                } 
                
                motorStates[deviceName][motorKey] = {
                    logicalState: 'idle', 
                    physicalState: 'unknown', 
                    direction: '',
                    currentPosition: position, 
                    lastPollTime: Date.now() 
                };
            });
        });
    }
}

// --- 【新增】当电机确认启动成功后，安排停止任务 ---
// function scheduleStopTask(deviceName, motor, duration, stopCmd) {
//     const motorChar = motor; 
//     const motorKey = `motor${motorChar}`; 
//     const timerKey = `${deviceName}-${motorChar}`;
    
//     console.log(`[TASK] ✅ ${deviceName}-${motorChar} 物理启动确认！开始计时: ${duration}秒`);

//     // 1. 写入任务到数据库 (计算预计停止时间)
//     const expectedStopTime = Date.now() + (duration * 1000);
//     db.run("REPLACE INTO motor_tasks (key, deviceName, motor, stopCmd, expectedStopTime) VALUES (?, ?, ?, ?, ?)", 
//         [timerKey, deviceName, motor, stopCmd, expectedStopTime], 
//         (err) => {
//             if (err) console.error(`[DB] ❌ 写入任务失败:`, err.message);
//             // else console.log(`[DB] ✅ 任务已持久化`);
//         }
//     );

//     // 2. 设置内存定时器
//     if (activeTimers[timerKey]) clearTimeout(activeTimers[timerKey].timeoutId);
    
//     const timeoutId = setTimeout(() => {
//         console.log(`[TIMER] ${deviceName}-${motorChar} 自动停止时间到。`);
//         // 触发停止逻辑 (含停止看门狗)
//         if (motorStates[deviceName]?.[motorKey]?.logicalState === 'running') {
//             handleStopMotorLogic(deviceName, motorKey, stopCmd);
//         }
//     }, duration * 1000);
    
//     activeTimers[timerKey] = { timeoutId, stopCmd };
// }
// --- 【修改】scheduleStopTask 函数 ---
function scheduleStopTask(deviceName, motor, duration, stopCmd) {
    const motorChar = motor; 
    const motorKey = `motor${motorChar}`; 
    const timerKey = `${deviceName}-${motorChar}`;
    
    // 计算具体的结束时间点
    const endTime = new Date(Date.now() + duration * 1000);
    const endTimeStr = endTime.toLocaleString('zh-CN', { hour12: false });

    // 打印清晰的日志
    console.log(`[${getLogTime()}] [⏳ 倒计时开始] ${deviceName}-${motorChar} 物理启动确认！将在 ${endTimeStr} 自动停止 (时长:${duration}s)`);

    const expectedStopTime = endTime.getTime();
    db.run("REPLACE INTO motor_tasks (key, deviceName, motor, stopCmd, expectedStopTime) VALUES (?, ?, ?, ?, ?)", 
        [timerKey, deviceName, motor, stopCmd, expectedStopTime]);

    if (activeTimers[timerKey]) clearTimeout(activeTimers[timerKey].timeoutId);
    
    const timeoutId = setTimeout(() => {
        console.log(`[${getLogTime()}] [⏰ 时间到] ${deviceName}-${motorChar} 触发自动停止逻辑`);
        if (motorStates[deviceName]?.[motorKey]?.logicalState === 'running') {
            handleStopMotorLogic(deviceName, motorKey, stopCmd);
        }
    }, duration * 1000);
    
    activeTimers[timerKey] = { timeoutId, stopCmd };
}

// --- 【新增】启动指令看门狗：确保电机转起来 ---
async function runStartWatchdog(deviceName, motorKey, startCmd, stopCmd, targetPhysState, duration, tryCount) {
    const motorChar = motorKey === 'motorA' ? 'A' : 'B';
    const state = motorStates[deviceName]?.[motorKey];

    // 0. 安全检查
    if (!state) return;

    // 1. 如果用户中途点了停止，logicalState 会变为 idle，此时应终止启动尝试
    if (state.logicalState !== 'running') {
        console.log(`[WATCHDOG-START] ⚠️ ${deviceName}-${motorChar} 用户已取消运行，停止启动重试。`);
        return;
    }

    // 2. 检查物理状态是否已符合预期 (targetPhysState: '1' or '3')
    // 注意：状态由 startProgressPolling 定时更新
    if (state.physicalState === targetPhysState) {
        console.log(`[WATCHDOG-START] ✅ ${deviceName}-${motorChar} 确认已启动 (状态:${targetPhysState})。看门狗任务结束。`);
        // 【关键步骤】只有确认启动了，才开始倒计时停止
        scheduleStopTask(deviceName, motorChar, duration, stopCmd);
        return;
    }

    // 3. 超时检查
    if (tryCount > WATCHDOG_CONFIG.MAX_RETRIES) {
        console.error(`[WATCHDOG-START] ❌ ${deviceName}-${motorChar} 启动失败！已重试 ${WATCHDOG_CONFIG.MAX_RETRIES} 次。`);
        // 重置状态，避免界面卡死
        state.logicalState = 'idle';
        broadcastMotorStates(deviceName);
        return;
    }

    // 4. 发送启动指令
    console.log(`[WATCHDOG-START] 🚀 第 ${tryCount} 次发送启动指令 [${startCmd}] -> ${deviceName}`);
    await sendCommandToOneNET(deviceName, startCmd);

    // 5. 等待间隔后递归检查
    setTimeout(() => {
        runStartWatchdog(deviceName, motorKey, startCmd, stopCmd, targetPhysState, duration, tryCount + 1);
    }, WATCHDOG_CONFIG.INTERVAL_MS);
}

// --- 【新增】停止指令看门狗：确保电机停下来 ---
async function runStopWatchdog(deviceName, motorKey, stopCmd, tryCount) {
    const motorChar = motorKey === 'motorA' ? 'A' : 'B';
    const state = motorStates[deviceName]?.[motorKey];
    if (!state) return;

    const physState = state.physicalState;
    // 定义“未停止”的状态：1=开运行, 3=关运行
    const isMoving = (physState === '1' || physState === '3');

    // 检查是否已停止 (非运行状态)
    // 注意：第一次进入时 tryCount=1，此时可能还没来得及停，所以通常 tryCount>1 才算有效确认
    if (!isMoving && tryCount > 1) {
        console.log(`[WATCHDOG-STOP] ✅ ${deviceName}-${motorChar} 确认已停止 (物理状态: ${physState})。`);
        startPostRunCooldown('电机停止确认');
        broadcastMotorStates(deviceName);
        return; 
    }

    if (tryCount > WATCHDOG_CONFIG.MAX_RETRIES) {
        console.error(`[WATCHDOG-STOP] ❌ ${deviceName}-${motorChar} 停止失败，已重试 ${WATCHDOG_CONFIG.MAX_RETRIES} 次。`);
        return;
    }

    console.log(`[WATCHDOG-STOP] 🛑 第 ${tryCount} 次发送停止指令 [${stopCmd}] -> ${deviceName}`);
    await sendCommandToOneNET(deviceName, stopCmd);

    // 等待间隔
    setTimeout(() => {
        // 如果逻辑状态变回 running 了，说明用户又开启了，停止看门狗退出
        if (state.logicalState === 'running') return;
        runStopWatchdog(deviceName, motorKey, stopCmd, tryCount + 1);
    }, WATCHDOG_CONFIG.INTERVAL_MS);
}

// --- 修改后的停止逻辑（调用看门狗） ---
// async function handleStopMotorLogic(deviceName, motorKey, stopCmd) {
//     const motorChar = motorKey === 'motorA' ? 'A' : 'B';
//     const timerKey = `${deviceName}-${motorChar}`;

//     // 1. 清除内存中的定时器
//     if (activeTimers[timerKey]) { 
//         console.log(`[STATE] 触发停止，清除 ${timerKey} 定时器。`);
//         clearTimeout(activeTimers[timerKey].timeoutId); 
//         delete activeTimers[timerKey]; 
//     }

//     // 2. 无论结果如何，先从数据库移除任务
//     db.run("DELETE FROM motor_tasks WHERE key = ?", [timerKey], (err) => {
//         if(err) console.error(`[DB] ❌ 删除任务记录失败 ${timerKey}:`, err.message);
//     });

//     const state = motorStates[deviceName]?.[motorKey];
//     if (!state) { console.error(`[STATE] 无法停止 ${deviceName}-${motorKey}，未找到状态。`); return { success: false }; }

//     // 3. 计算位置 (Dead Reckoning)
//     const now = Date.now();
//     const timeDelta = now - state.lastPollTime;
//     const deviceConfig = DEVICE_CONFIGS[deviceName];
    
//     if (deviceConfig) {
//         const totalTravelTime = (motorChar === 'A') ? deviceConfig.timeA : deviceConfig.timeB;
//         const positionChange = (timeDelta / totalTravelTime) * 100;

//         if (state.logicalState === 'running') { 
//             if (state.physicalState === '1') { 
//                 state.currentPosition = Math.min(100, state.currentPosition + positionChange);
//             } else if (state.physicalState === '3') { 
//                 state.currentPosition = Math.max(0, state.currentPosition - positionChange);
//             }
//         }
//     }

//     // 4. 更新逻辑状态为 idle
//     state.logicalState = 'idle';
//     state.direction = '';
    
//     const finalPosition = state.currentPosition;
//     savePositionToDB(deviceName, motorChar, finalPosition);

//     // 5. 【核心】启动停止看门狗循环
//     console.log(`[WATCHDOG] 🐕 启动 ${deviceName}-${motorChar} 停止确认循环...`);
//     runStopWatchdog(deviceName, motorKey, stopCmd, 1);

//     broadcastMotorStates(deviceName); 
//     return { success: true };
// }
// --- 【修改】handleStopMotorLogic 函数 ---
async function handleStopMotorLogic(deviceName, motorKey, stopCmd) {
    const motorChar = motorKey === 'motorA' ? 'A' : 'B';
    const timerKey = `${deviceName}-${motorChar}`;

    if (activeTimers[timerKey]) { 
        clearTimeout(activeTimers[timerKey].timeoutId); 
        delete activeTimers[timerKey]; 
    }

    db.run("DELETE FROM motor_tasks WHERE key = ?", [timerKey], (err) => {});

    const state = motorStates[deviceName]?.[motorKey];
    if (!state) return { success: false };

    // 位置计算逻辑保持不变
    const now = Date.now();
    const timeDelta = now - state.lastPollTime;
    const deviceConfig = DEVICE_CONFIGS[deviceName];
    if (deviceConfig) {
        const totalTravelTime = (motorChar === 'A') ? deviceConfig.timeA : deviceConfig.timeB;
        const positionChange = (timeDelta / totalTravelTime) * 100;
        if (state.logicalState === 'running') { 
            if (state.physicalState === '1') state.currentPosition = Math.min(100, state.currentPosition + positionChange);
            else if (state.physicalState === '3') state.currentPosition = Math.max(0, state.currentPosition - positionChange);
        }
    }

    state.logicalState = 'idle';
    state.direction = '';
    
    savePositionToDB(deviceName, motorChar, state.currentPosition);

    // 【修改点】增加了带时间的日志
    console.log(`[${getLogTime()}] [🛑 执行停止] ${deviceName}-${motorChar} 发送停止指令 [${stopCmd}]`);
    
    runStopWatchdog(deviceName, motorKey, stopCmd, 1);
    broadcastMotorStates(deviceName); 
    return { success: true };
}

async function fetchAndStoreSensorData() {
    const timestampISO = new Date().toISOString();
    const headers = { 'Authorization': ONENET_CONFIG.auth_info };
    const stmt = db.prepare("INSERT OR IGNORE INTO sensor_data (deviceName, identifier, timestamp, value) VALUES (?, ?, ?, ?)");
    for (const deviceName of DEVICES_TO_SYNC) {
        const url = `${ONENET_CONFIG.api_base_url}/thingmodel/query-device-property?product_id=${ONENET_CONFIG.product_id}&device_name=${deviceName}`;
        try {
            const response = await axios.get(url, { headers });
            if (response.data.code === 0 && response.data.data) {
                for (const item of response.data.data) {
                    const identifier = item.identifier;
                    const value = parseFloat(item.value);
                    if (!isNaN(value)) {
                        stmt.run(deviceName, identifier, timestampISO, value);
                    }
                }
            }
        } catch (error) {
            console.error(`[PULL] ❌ 请求 ${deviceName} 网络错误`);
        }
    }
    stmt.finalize();
}

function startPostRunCooldown(reason) {
    globalCooldownUntil = Date.now() + POST_RUN_COOLDOWN;
}

async function sendCommandToOneNET(deviceName, command) {
    const url = `${ONENET_CONFIG.api_base_url}/thingmodel/set-device-desired-property`;
    const headers = { 'Authorization': ONENET_CONFIG.auth_info };
    const data = { product_id: ONENET_CONFIG.product_id, device_name: deviceName, params: { [ONENET_CONFIG.identifiers.MOTOR]: command } };
    try {
        const response = await axios.post(url, data, { headers });
        if (response.data.code === 0 && response.data.msg === 'succ') return true;
        else {
            console.error(`[CMD_SEND] ❌ OneNET 返回错误:`, JSON.stringify(response.data));
            return false;
        }
    } catch (error) {
        console.error(`[CMD_SEND] ❌ 网络错误:`, error.message);
        return false;
    }
}

async function queryDeviceStatus(deviceName) {
    const url = `${ONENET_CONFIG.api_base_url}/device/detail?product_id=${ONENET_CONFIG.product_id}&device_name=${deviceName}`;
    try {
        const response = await axios.get(url, { headers: { 'Authorization': ONENET_CONFIG.auth_info } });
        return response.data.code === 0 && response.data.data && response.data.data.status === 1;
    } catch (error) { return false; }
}

function cleanOldData() {
    const threeMonthsAgoISO = new Date(new Date().setMonth(new Date().getMonth() - 3)).toISOString();
    db.run("DELETE FROM sensor_data WHERE timestamp < ?", [threeMonthsAgoISO]);


    // --- 【新增步骤 5】清理旧日志 ---
    const oneMonthAgo = new Date(new Date().setDate(new Date().getDate() - 30)).toISOString();
    db.run("DELETE FROM command_logs WHERE timestamp < ?", [oneMonthAgo], (err) => {
        if (!err) console.log("✅ 已自动清理30天前的操作日志");
    });
}

// --- 【新增功能】系统级兜底停止机制 ---
// function runFailsafeStopRoutine() {
//     console.log('[FAILSAFE] 🛡️ 启动每小时强制停止兜底机制...');
    
//     // 遍历所有设备
//     DEVICES_TO_SYNC.forEach(deviceName => {
//         // 定义该设备的4个停止指令序列，每个间隔60秒 (60000ms)
//         // 指令码来自于 COMMANDS_MAP 
//         // 上通风关停止(BB12G), 上通风开停止(DD12G), 下通风关停止(FF12G), 下通风开停止(HH12G)
//         const stopSequence = [
//             { cmd: 'BB12G', desc: '上通风口关停止', delay: 0 },
//             { cmd: 'DD12G', desc: '上通风口开停止', delay: 60000 },
//             { cmd: 'FF12G', desc: '下通风口关停止', delay: 120000 },
//             { cmd: 'HH12G', desc: '下通风口开停止', delay: 180000 }
//         ];

//         // 依次设置定时器发送指令
//         stopSequence.forEach(step => {
//             setTimeout(async () => {
//                 console.log(`[FAILSAFE] 🛡️ 对 ${deviceName} 执行兜底: ${step.desc}`);
//                 // 发送指令（这里不走 handleStopMotorLogic，而是直接发送物理指令以确保送达）
//                 await sendCommandToOneNET(deviceName, step.cmd);
                
//                 // 可选：记录到系统日志
//                 // logUserAction(null, deviceName, '系统兜底', step.desc);
//             }, step.delay);
//         });
//     });
// }

// --- runFailsafeStopRoutine 函数 (接入看门狗机制) ---
function runFailsafeStopRoutine() {
    console.log(`[${getLogTime()}] [🛡️ 系统兜底] 开始执行每小时强制停止检查...`);
    
    DEVICES_TO_SYNC.forEach(deviceName => {
        // 我们给每个步骤增加了 'motorKey' 字段，告诉看门狗要监视哪个电机
        const stopSequence = [
            { cmd: 'BB12G', desc: '上通风口关停止', delay: 0,      motorKey: 'motorA' },
            { cmd: 'DD12G', desc: '上通风口开停止', delay: 60000,  motorKey: 'motorA' },
            { cmd: 'FF12G', desc: '下通风口关停止', delay: 120000, motorKey: 'motorB' },
            { cmd: 'HH12G', desc: '下通风口开停止', delay: 180000, motorKey: 'motorB' }
        ];

        stopSequence.forEach(step => {
            setTimeout(() => {
                console.log(`[${getLogTime()}] [🛡️ 兜底执行] ${deviceName} -> 启动看门狗验证: ${step.desc}`);
                
                // 【核心修改】这里不再直接发送指令，而是调用看门狗
                // 参数: (设备名, 电机Key, 停止指令, 第1次尝试)
                // 看门狗会自动检测是否停止，未停止则最多重试10次
                runStopWatchdog(deviceName, step.motorKey, step.cmd, 1);
                
            }, step.delay);
        });
    });
}

function scheduleJobs() {
    console.log('[SCHEDULER] ✅ Tasks scheduled');
    fetchAndStoreSensorData(); 
    
    // 1. 传感器数据轮询 (每10分钟)
    cron.schedule('*/10 * * * *', fetchAndStoreSensorData);
    
    // 2. 数据清理 (每天凌晨2:15)
    cron.schedule('15 2 * * *', cleanOldData);

    // 3. 【新增】每小时执行一次停止指令兜底 (每小时的第0分钟执行)
    // 依次执行：上关停 ->(1min)-> 上开停 ->(1min)-> 下关停 ->(1min)-> 下开停
    cron.schedule('0 1,3,5,12,14,16,19,23 * * *', runFailsafeStopRoutine);
}

async function fetchDeviceProperties(deviceName) {
    const url = `${ONENET_CONFIG.api_base_url}/thingmodel/query-device-property?product_id=${ONENET_CONFIG.product_id}&device_name=${deviceName}&identifier=motor1,motor2`;
    const headers = { 'Authorization': ONENET_CONFIG.auth_info };
    let properties = { motor1: 'unknown', motor2: 'unknown' };
    try {
        const response = await axios.get(url, { headers });
        if (response.data.code === 0 && response.data.data) {
            for (const item of response.data.data) {
                if (item.identifier === 'motor1') properties.motor1 = String(item.value);
                else if (item.identifier === 'motor2') properties.motor2 = String(item.value);
            }
        }
    } catch (error) {}
    return properties;
}

function processMotor(deviceName, motorChar, physicalValue, state) {
    const now = Date.now();
    const lastPollTime = state.lastPollTime;
    const timeDelta = now - lastPollTime;
    state.lastPollTime = now;
    state.physicalState = physicalValue;
    
    // 如果轮询间隔太久，不进行位移计算
    if (timeDelta > (POLL_INTERVAL_MS * 5)) return;

    const deviceConfig = DEVICE_CONFIGS[deviceName];
    if (!deviceConfig) return;
    const totalTravelTime = (motorChar === 'A') ? deviceConfig.timeA : deviceConfig.timeB;
    const positionChange = (timeDelta / totalTravelTime) * 100;

    if (physicalValue === '1') state.currentPosition = Math.min(100, state.currentPosition + positionChange);
    else if (physicalValue === '3') state.currentPosition = Math.max(0, state.currentPosition - positionChange);
}

function startProgressPolling() {
    console.log(`[POLL] ✅ 启动进度轮询器 (间隔: ${POLL_INTERVAL_MS}ms)`);
    setInterval(async () => {
        for (const deviceName of DEVICES_TO_SYNC) {
            if (!motorStates[deviceName]) continue;
            const props = await fetchDeviceProperties(deviceName);
            processMotor(deviceName, 'A', props.motor1, motorStates[deviceName].motorA);
            processMotor(deviceName, 'B', props.motor2, motorStates[deviceName].motorB);
            broadcastMotorStates(deviceName);
        }
    }, POLL_INTERVAL_MS);
}

// --- API 端点 ---

app.get('/api/get-motor-states', (req, res) => {
    const { deviceName } = req.query;
    if (!deviceName) return res.status(400).json({ success: false, message: "缺少 deviceName" });
    const states = motorStates[deviceName];
    if (!states) return res.status(404).json({ success: false, message: "设备状态尚未初始化" });
    
    const formattedStates = {
        motorA: formatClientState('A', states.motorA),
        motorB: formatClientState('B', states.motorB),
    };
    res.status(200).json({ success: true, data: formattedStates });
});

app.post('/api/start-timed-motor', async (req, res) => {
    const { deviceName, motor, direction, duration } = req.body;
    const validatedDuration = Number(duration);
    
    // 参数校验
    if (!deviceName || !motor || !direction || !(validatedDuration > 0)) {
        return res.status(400).json({ success: false, message: "参数不完整或时长无效" });
    }
    
    // 全局冷却检查
    if (Date.now() < globalCooldownUntil) {
        const remaining = Math.ceil((globalCooldownUntil - Date.now()) / 1000);
        return res.status(429).json({ success: false, message: `指令冷却中，请在 ${remaining} 秒后重试` });
    }

    // 在线状态检查
    const isOnline = await queryDeviceStatus(deviceName);
    if (!isOnline) return res.status(400).json({ success: false, message: "设备当前不在线" });

    const motorChar = motor; 
    const motorKey = `motor${motorChar}`; 
    
    // 获取指令配置
    const motorCommands = COMMANDS_MAP[motorChar]?.[direction];
    if (!motorCommands) return res.status(400).json({ success: false, message: "无效的电机或方向参数" });
    
    const { start: startCmd, stop: stopCmd, runState: targetPhysState } = motorCommands;

    // 互斥检查（同一个设备的另一个电机是否在运行）
    const otherMotorKey = (motorKey === 'motorA') ? 'motorB' : 'motorA';
    if (motorStates[deviceName]?.[otherMotorKey]?.logicalState === 'running') {
        return res.status(400).json({ success: false, message: "另一电机运行中，请稍后" });
    }

    // 自身状态检查
    const currentState = motorStates[deviceName]?.[motorKey];
    if (!currentState) return res.status(500).json({ success: false, message: "电机状态未初始化" });
    if (currentState.logicalState === 'running') return res.status(400).json({ success: false, message: "该电机已在运行中" });

    // --- 【修改核心】精确的中文日志记录 ---
    // --- 【新代码】用户启动日志 ---
    const ventName = (motorChar === 'A') ? '上通风口' : '下通风口';
    const actionName = (direction === 'forward') ? '关运行' : '开运行';
    
    // 计算预计结束时间，方便查看
    const expectedEndTime = new Date(Date.now() + validatedDuration * 1000).toLocaleString('zh-CN', { hour12: false });

    console.log(`[${getLogTime()}] [🚀 用户指令] ${deviceName} ${ventName} ${actionName} (时长:${validatedDuration}秒) -> 预计结束: ${expectedEndTime}`);
    
    logUserAction(req, deviceName, '启动指令', `${ventName}${actionName} (时长${validatedDuration}秒)`);

    // 更新内存状态
    currentState.logicalState = 'running';
    currentState.direction = direction;
    currentState.lastPollTime = Date.now(); 

    broadcastMotorStates(deviceName); 

    // 启动看门狗任务
    runStartWatchdog(deviceName, motorKey, startCmd, stopCmd, targetPhysState, validatedDuration, 1);

    res.status(200).json({ success: true, message: "启动指令已进入队列" });
});

app.post('/api/set-motor-position', (req, res) => {
    const { deviceName, motor, position } = req.body;
    const newPosition = Number(position);
    if (!deviceName || !motor || (newPosition !== 0 && newPosition !== 100)) return res.status(400).json({ success: false, message: "参数无效" });
    
    const motorChar = motor; 
    const motorKey = `motor${motorChar}`;
    
    const currentState = motorStates[deviceName]?.[motorKey];
    if (!currentState) return res.status(500).json({ success: false, message: "电机状态未初始化" });
    if (currentState.logicalState === 'running') return res.status(400).json({ success: false, message: "电机正在运行，无法校准" });

    currentState.currentPosition = newPosition;
    // --- 【新增日志步骤 3.2】记录校准日志 ---
    logUserAction(req, deviceName, '强制校准', `电机${motorChar} 校准为 ${newPosition}%`);
    console.log(`[STATE] 校准：${motorKey} 位置被强制设置为 ${newPosition}%`);
    
    savePositionToDB(deviceName, motorChar, newPosition);
    broadcastMotorStates(deviceName);
    res.status(200).json({ success: true, message: "校准成功" });
});

app.get('/api/devices', (req, res) => { res.status(200).json({ success: true, data: DEVICES_TO_SYNC }); });

app.post('/api/stop-motor', async (req, res) => {
    const { deviceName, motor, stopCmd } = req.body;
    
    // 参数校验
    if (!deviceName || !motor || !stopCmd) {
        return res.status(400).json({ success: false, message: "缺少必要参数" });
    }
    
    // 在线检查
    const isOnline = await queryDeviceStatus(deviceName);
    if (!isOnline) return res.status(400).json({ success: false, message: "设备当前不在线" });

    const motorKey = `motor${motor}`;

    // --- 【修改核心】精确识别是“开停止”还是“关停止” ---
    // 1. 翻译电机名称
    const ventName = (motor === 'A') ? '上通风口' : '下通风口';
    let stopType = '停止'; // 默认兜底值

    // 2. 反查指令含义 (判断 stopCmd 属于哪种操作的停止码)
    const cmds = COMMANDS_MAP[motor];
    if (cmds) {
        if (cmds.forward.stop === stopCmd) {
            stopType = '关停止'; // 对应正转(关)的停止码
        } else if (cmds.reverse.stop === stopCmd) {
            stopType = '开停止'; // 对应反转(开)的停止码
        }
    }

    // 3. 写入数据库
    logUserAction(req, deviceName, '停止指令', `${ventName}${stopType}`);
    // ------------------------------------------------

    // 执行停止逻辑
    const result = await handleStopMotorLogic(deviceName, motorKey, stopCmd); 

    if (result.success) {
        res.status(200).json({ success: true, message: "停止指令已发送" });
    } else {
        res.status(500).json({ success: false, message: "发送停止指令失败" });
    }
});


// --- 【新增日志步骤 4】获取操作日志的 API ---
app.get('/api/logs', (req, res) => {
    const { deviceName, startDate, endDate } = req.query;
    let query = "SELECT * FROM command_logs WHERE 1=1";
    const params = [];

    // 如果有日期筛选
    if (startDate && endDate) {
        try {
            const startISO = new Date(startDate).toISOString();
            const endISO = new Date(endDate).toISOString();
            query += " AND timestamp >= ? AND timestamp <= ?";
            params.push(startISO, endISO);
        } catch (e) {
            return res.status(400).json({ success: false, message: '日期格式错误' });
        }
    } else {
        // 如果没传日期，默认只查最近 50 条
        query += " ORDER BY timestamp DESC LIMIT 50";
        return db.all(query, params, (err, rows) => {
             if (err) return res.status(500).json({ success: false, message: err.message });
             res.status(200).json({ success: true, data: rows });
        });
    }

    if (deviceName) {
        query += " AND deviceName = ?";
        params.push(deviceName);
    }

    query += " ORDER BY timestamp DESC"; // 最新的显示在前面

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: '查询日志失败', error: err.message });
        res.status(200).json({ success: true, data: rows });
    });
});


app.get('/api/data', (req, res) => {
    const { deviceName, identifier, startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ success: false, message: '必须提供 startDate 和 endDate' });
    let query = "SELECT * FROM sensor_data WHERE timestamp >= ? AND timestamp <= ?";
    let startISO, endISO;
    try {
        startISO = new Date(startDate).toISOString();
        endISO = new Date(endDate).toISOString();
    } catch (e) { return res.status(400).json({ success: false, message: '无效的日期格式' }); }
    const params = [startISO, endISO];
    if (deviceName) { query += " AND deviceName = ?"; params.push(deviceName); }
    if (identifier) { query += " AND identifier = ?"; params.push(identifier); }
    query += " ORDER BY timestamp ASC";
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: '查询数据失败', error: err.message });
        res.status(200).json({ success: true, data: rows });
    });
});

app.get('/api/export', (req, res) => {
    const { deviceName, identifier, startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ success: false, message: '必须提供 startDate 和 endDate' });
    let query = "SELECT * FROM sensor_data WHERE timestamp >= ? AND timestamp <= ?";
     let startISO, endISO;
    try {
        startISO = new Date(startDate).toISOString();
        endISO = new Date(endDate).toISOString();
    } catch (e) { return res.status(400).send('无效的日期格式'); }
    const params = [startISO, endISO];
    if (deviceName) { query += " AND deviceName = ?"; params.push(deviceName); }
    if (identifier) { query += " AND identifier = ?"; params.push(identifier); }
    query += " ORDER BY timestamp ASC";
    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).send('查询DB导出失败: ' + err.message);
        if (rows.length === 0) return res.status(404).send('指定范围内无数据');
        const fields = ['deviceName', 'identifier', 'value', 'timestamp'];
        try {
            const json2csvParser = new Parser({ fields });
            const csv = json2csvParser.parse(rows);
            res.header('Content-Type', 'text/csv');
            const devicePart = deviceName ? deviceName : 'all';
            const startPart = startDate.replace(/[: T]/g, '-').split('.')[0];
            const endPart = endDate.replace(/[: T]/g, '-').split('.')[0];
            const fileName = `export_${devicePart}_${startPart}_to_${endPart}.csv`;
            res.attachment(fileName);
            res.status(200).send(csv);
        } catch (parseErr) {
            console.error("导出 CSV 出错:", parseErr);
            res.status(500).send('生成CSV出错');
        }
    });
});

const PORT = 8081;
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let connectedClients = new Set();
console.log('✅ WebSocket 服务器准备就绪');

wss.on('connection', (ws) => {
    connectedClients.add(ws);
    // 连接时发送所有设备的最新状态
    for (const deviceName of DEVICES_TO_SYNC) {
        const states = motorStates[deviceName];
        if (states) {
            const formattedStates = {
                motorA: formatClientState('A', states.motorA),
                motorB: formatClientState('B', states.motorB),
                deviceName: deviceName 
            };
            ws.send(JSON.stringify({ type: 'motorStates', data: formattedStates }));
        }
    }

    ws.on('close', () => connectedClients.delete(ws));
    ws.on('error', () => connectedClients.delete(ws));
});

function broadcastMotorStates(deviceName) {
    if (connectedClients.size === 0) return;
    const states = motorStates[deviceName];
    if (!states) return;

    const formattedStates = {
        motorA: formatClientState('A', states.motorA),
        motorB: formatClientState('B', states.motorB),
        deviceName: deviceName 
    };
    const payload = JSON.stringify({ type: 'motorStates', data: formattedStates });

    for (const client of connectedClients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        } else {
            connectedClients.delete(client);
        }
    }
}

function formatClientState(motorChar, state) {
    let physicalStateText = '状态未知';
    const physState = state.physicalState || 'unknown'; 
    
    if (motorChar === 'A') {
        switch(physState) {
            case '1': physicalStateText = '上通风口开运行状态'; break;
            case '2': physicalStateText = '上通风口开停止状态'; break;
            case '3': physicalStateText = '上通风口关运行状态'; break;
            case '4': physicalStateText = '上通风口关停止状态'; break;
        }
    } else { 
        switch(physState) {
            case '1': physicalStateText = '下通风口开运行状态'; break;
            case '2': physicalStateText = '下通风口开停止状态'; break;
            case '3': physicalStateText = '下通风口关运行状态'; break;
            case '4': physicalStateText = '下通风口关停止状态'; break;
        }
    }
    
    return {
        isRunning: (state.logicalState === 'running'),
        physicalState: physState, 
        physicalStateText: physicalStateText, 
        currentPosition: Math.floor(state.currentPosition)
    };
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ IoT 服务 (HTTP + WS) 启动于端口 ${PORT}`);
    console.log(`   Web: http://<YOUR_IP>:${PORT}`);
});