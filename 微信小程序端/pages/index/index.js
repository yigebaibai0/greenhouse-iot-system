const { config, devices } = require('../../utils/config.js');
const util = require('../../utils/util.js');

// ⚠️ 部署后请替换为你的服务器地址（注意：必须是 wss:// 如果服务器启用了 SSL，否则用 ws://）
const WS_URL = 'ws://YOUR_SERVER_IP:8081'; 


const FEEDBACK_MAP = {
  'AA12G': ['motor1', '3'], 'CC12G': ['motor1', '1'],
  'BB12G': ['motor1', '4'], 'DD12G': ['motor1', '2'],
  'EE12G': ['motor2', '3'], 'GG12G': ['motor2', '1'],
  'FF12G': ['motor2', '4'], 'HH12G': ['motor2', '2'],
};

const COMMANDS_MAP = {
    A: { // motor1
        forward: { start: 'AA12G', stop: 'BB12G', runState: '3', stopState: '4' }, // 关
        reverse: { start: 'CC12G', stop: 'DD12G', runState: '1', stopState: '2' }  // 开
    },
    B: { // motor2
        forward: { start: 'EE12G', stop: 'FF12G', runState: '3', stopState: '4' }, // 关
        reverse: { start: 'GG12G', stop: 'HH12G', runState: '1', stopState: '2' }  // 开
    }
};

const COMMAND_TEXT_MAP = {
  'AA12G': '电机A 正转开', 'BB12G': '电机A 正转关',
  'CC12G': '电机A 反转开', 'DD12G': '电机A 反转关',
  'EE12G': '电机B 正转开', 'FF12G': '电机B 正转关',
  'GG12G': '电机B 反转开', 'HH12G': '电机B 反转关',
};


Page({
    data: {
      currentDevice: null,
      device_properties: { motor1: 0, motor2: 0 }, 
      
      device_properties_text: {
        motor1_text: 'N/A',
        motor2_text: 'N/A'
      },

      device_online_status: '查询中...',
      motorA: {
        duration: 10,
        progress: 100,
        isRunning: false, 
        timer: null,
        runningState: 'unknown', 
        runningStateText: '状态未知', 
      },
      motorB: {
        duration: 10,
        progress: 100,
        isRunning: false,
        timer: null,
        runningState: 'unknown', 
        runningStateText: '状态未知',
      },
      tempDurationA: 0,
      tempDurationB: 0,
      mainTimer: null,
      deviceStatusFailCount: 0,
      
      ws: null, 
      wsReconnectTimer: null,
      wsConnected: false
    },

    resetMotorStateUI(motorKey) { console.warn("resetMotorStateUI 已废弃"); },

    startMotorHandler(event) {
        const { motor, direction } = event.currentTarget.dataset;
        const motorState = motor === 'A' ? this.data.motorA : this.data.motorB;
        const anotherMotorState = motor === 'A' ? this.data.motorB : this.data.motorA;
        if (motorState.isRunning) { wx.showToast({ title: '电机运行中', icon: 'none' }); return; }
        if (anotherMotorState.isRunning) { wx.showToast({ title: '另一电机运行中', icon: 'none' }); return; }
        const uiDuration = motorState.duration;
        if (!(uiDuration > 0)) { wx.showToast({ title: '时长无效', icon: 'none' }); return; }
        if (this.data.device_online_status !== '在线') { wx.showToast({ title: '设备不在线', icon: 'none' }); return; }
        
        const motorCommands = COMMANDS_MAP[motor]?.[direction]; 
        if (!motorCommands) { console.error("无法找到指令", motor, direction); return; }

        const requestData = { deviceName: this.data.currentDevice.deviceName, motor: motor, direction: direction, duration: Number(uiDuration) };
        wx.showLoading({ title: '发送指令...' });
        wx.request({
            url: `${config.server_base_url}/api/start-timed-motor`,
            method: 'POST', data: requestData,
            success: (res) => {
                wx.hideLoading();
                if (res.statusCode === 200 && res.data.success) {
                    console.log(`[CMD] 启动指令 [${motor}] 已发送。`);
                    wx.showToast({ title: '启动指令已发', icon: 'success' });
                } else {
                    console.error('[CMD] 启动失败:', res.data.message || `状态码 ${res.statusCode}`);
                    wx.showModal({ title: '启动失败', content: `错误: ${res.data.message || '服务器未响应'}`, showCancel: false, confirmText: '好的' });
                }
            },
            fail: (err) => {
                wx.hideLoading(); console.error('[CMD] 启动网络错误:', err);
                wx.showModal({ title: '网络错误', content: '无法连接服务器', showCancel: false, confirmText: '好的' });
            }
        });
    },

    stopMotorHandler(event) {
        const { motor, stopcmd } = event.currentTarget.dataset;
        if (this.data.device_online_status !== '在线') { wx.showToast({ title: '设备不在线', icon: 'none' }); return; }
        
        this.sendStopCommand(motor, stopcmd);
    },

    sendStopCommand(motor, stopcmd) {
        const cmdText = COMMAND_TEXT_MAP[stopcmd] || '停止指令';
        wx.showToast({ title: `${cmdText} 已发送`, icon: 'success', duration: 1500 });
        
        wx.request({
            url: `${config.server_base_url}/api/stop-motor`,
            method: 'POST', data: { deviceName: this.data.currentDevice.deviceName, motor: motor, stopCmd: stopcmd },
            success: (res) => {
                if (res.statusCode === 200 && res.data.success) {
                } else {
                    console.error(`[STOP CMD SEND FAILED] ${res.data.message || '服务器错误'}`);
                }
            },
            fail: (err) => {
                console.error(`[STOP CMD NETWORK FAILED] ${err.errMsg}`);
            }
        });
    },

    onLoad(options) {
        const deviceIndex = options.deviceIndex;
        if (deviceIndex === undefined) { wx.showToast({ title: '页面加载错误', icon: 'error' }); wx.navigateBack(); return; }
        const device = devices[deviceIndex];
        this.setData({ currentDevice: device });
        wx.setNavigationBarTitle({ title: device.name + ' - 控制中心' });
        this.loadMotorDurations();
    },
    onShow() { 
        this.fetch_all_data(); 
        this.connectWebSocket(); 
    },
    onHide() { 
        this.clearAllTimers(); 
        if (this.data.ws) {
            this.data.ws.close({
                code: 1000,
                reason: 'Page hidden'
            });
        }
    },
    onUnload() { 
        this.clearAllTimers(); 
        if (this.data.ws) {
            this.data.ws.close({
                code: 1000,
                reason: 'Page unloaded'
            });
        }
    },
    clearAllTimers() {
        if (this.data.mainTimer) clearInterval(this.data.mainTimer);
        if (this.data.wsReconnectTimer) clearTimeout(this.data.wsReconnectTimer);

        this.setData({
            mainTimer: null, 
            wsReconnectTimer: null
        });
    },
    loadMotorDurations() {
        const deviceName = this.data.currentDevice.deviceName;
        const keyA = `${deviceName}_motorADuration`; const keyB = `${deviceName}_motorBDuration`;
        const savedDurationA = wx.getStorageSync(keyA); const savedDurationB = wx.getStorageSync(keyB);
        this.setData({
            'motorA.duration': (savedDurationA !== '' && savedDurationA !== null) ? savedDurationA : 10,
            'motorB.duration': (savedDurationB !== '' && savedDurationB !== null) ? savedDurationB : 10
        });
    },
    onDurationFocusA(e) { this.setData({ tempDurationA: this.data.motorA.duration }); },
    onDurationFocusB(e) { this.setData({ tempDurationB: this.data.motorB.duration }); },
    onDurationChangeConfirmA(e) {
        const newDuration = Number(e.detail.value) || 0; const oldDuration = this.data.tempDurationA; if (newDuration === oldDuration) return; if (newDuration <= 0) { wx.showToast({ title: '时长需>0', icon: 'none' }); this.setData({ 'motorA.duration': oldDuration }); return; } wx.showModal({ title: '确认修改', content: `电机A时长改为 ${newDuration} 秒?`, success: (res) => { if (res.confirm) { this.setData({ 'motorA.duration': newDuration }); wx.setStorageSync(`${this.data.currentDevice.deviceName}_motorADuration`, newDuration); wx.showToast({ title: '修改成功', icon: 'success' }); } else if (res.cancel) { this.setData({ 'motorA.duration': oldDuration }); } } });
    },
    onDurationChangeConfirmB(e) {
        const newDuration = Number(e.detail.value) || 0; const oldDuration = this.data.tempDurationB; if (newDuration === oldDuration) return; if (newDuration <= 0) { wx.showToast({ title: '时长需>0', icon: 'none' }); this.setData({ 'motorB.duration': oldDuration }); return; } wx.showModal({ title: '确认修改', content: `电机B时长改为 ${newDuration} 秒?`, success: (res) => { if (res.confirm) { this.setData({ 'motorB.duration': newDuration }); wx.setStorageSync(`${this.data.currentDevice.deviceName}_motorBDuration`, newDuration); wx.showToast({ title: '修改成功', icon: 'success' }); } else if (res.cancel) { this.setData({ 'motorB.duration': oldDuration }); } } });
    },

    updateAllDeviceData(properties) {
        this.setData({ device_properties: properties });
    },
    
    fetch_all_data() {
        if (!this.data.currentDevice) return; 
        const deviceName = this.data.currentDevice.deviceName;
        
        const identifiersToFetch = ['Temp', 'Humi', 'Lux', 'Ec', 'Humi1', 'Temp1'];
        
        util.fetchDeviceProperties(deviceName, identifiersToFetch.join(',')).then(data => { 
            this.updateAllDeviceData(data.properties); 
        }).catch(err => { 
            console.error(`GetProps ${deviceName} failed:`, err); 
        });
        
        util.fetchDeviceStatus(deviceName).then(status => { 
            this.setData({ device_online_status: status, deviceStatusFailCount: 0 }); 
        }).catch(err => { 
            console.error(`GetStatus ${deviceName} failed:`, err); 
            const newFailCount = this.data.deviceStatusFailCount + 1;
            if (newFailCount >= 3) {
                this.setData({ device_online_status: '查询失败', deviceStatusFailCount: newFailCount });
            } else {
                this.setData({ deviceStatusFailCount: newFailCount });
            }
        });
        
        if (!this.data.mainTimer) {
            console.log("启动传感器/设备状态定时刷新 (mainTimer)...");
            const timer = setInterval(() => {
                if (!this.data.currentDevice) return; 
                const currentDeviceName = this.data.currentDevice.deviceName;
                
                util.fetchDeviceProperties(currentDeviceName, identifiersToFetch.join(',')).then(data => { 
                    this.updateAllDeviceData(data.properties); 
                }).catch(err => { 
                    console.error(`TickProps ${currentDeviceName} fail:`, err); 
                });
                
                util.fetchDeviceStatus(currentDeviceName).then(status => { 
                    this.setData({ device_online_status: status, deviceStatusFailCount: 0 }); 
                }).catch(err => { 
                    console.error(`TickStatus ${currentDeviceName} fail:`, err); 
                    const newFailCount = this.data.deviceStatusFailCount + 1;
                    if (newFailCount >= 3) {
                        this.setData({ device_online_status: '查询失败', deviceStatusFailCount: newFailCount });
                    } else {
                        this.setData({ deviceStatusFailCount: newFailCount });
                    }
                });
            }, 10000); 
            this.setData({ mainTimer: timer });
        }
    },

    connectWebSocket() {
        if (this.data.wsConnected || this.data.ws) return;
        if (this.data.wsReconnectTimer) {
            clearTimeout(this.data.wsReconnectTimer);
            this.setData({ wsReconnectTimer: null });
        }

        console.log('[WS] 准备连接到', WS_URL);
        wx.showLoading({ title: '连接服务器...', mask: true });

        const ws = wx.connectSocket({
            url: WS_URL,
            header: { 'content-type': 'application/json' },
            success: () => console.log('[WS] connectSocket 调用成功'),
            fail: (err) => {
                console.error('[WS] connectSocket 调用失败', err)
                wx.hideLoading();
                this.reconnectWebSocket(); 
            }
        });
        this.setData({ ws: ws }); 

        ws.onOpen(() => {
            wx.hideLoading();
            console.log('[WS] ✅ 连接已打开');
            this.setData({ wsConnected: true }); 
            wx.showToast({ title: '已连接', icon: 'success', duration: 1500 });
        });

        ws.onMessage((res) => {
            try {
                const message = JSON.parse(res.data);
                if (message.type === 'motorStates') {
                    // console.log('[WS] 更新状态:', message.data); 
                    this.updateUIFromStates(message.data);
                }
            } catch (e) {
                console.error('[WS] ❌ 解析消息失败:', e.message, res.data);
            }
        });

        ws.onClose((res) => {
            wx.hideLoading();
            console.log(`[WS] ⚠️ 连接已关闭 (Code: ${res.code}, Reason: ${res.reason})`);
            this.setData({ wsConnected: false, ws: null });
            if (res.code !== 1000) {
                wx.showToast({ title: '连接已断开', icon: 'none' });
                this.reconnectWebSocket();
            }
        });

        ws.onError((err) => {
            wx.hideLoading();
            console.error('[WS] ❌ 连接发生错误:', err);
            this.setData({ wsConnected: false, ws: null });
        });
    },

    reconnectWebSocket() {
        if (this.data.wsReconnectTimer || this.data.wsConnected) return; 
        console.log('[WS] 5秒后尝试重连...');
        const timer = setTimeout(() => {
            this.setData({ wsReconnectTimer: null });
            this.connectWebSocket();
        }, 5000);
        this.setData({ wsReconnectTimer: timer });
    },
    
    // --- 【修改】updateUIFromStates (核心) ---
    // 接收来自服务器的格式化状态，并校验是否属于当前设备
    updateUIFromStates(serverStates) {
        // 安全检查
        if (!this.data.currentDevice) return;
        
        // --- 【核心修改】检查消息中的 deviceName 是否匹配当前页面设备 ---
        // 假设服务器返回的数据结构里包含 deviceName
        // 如果服务器广播的是所有设备，我们需要筛选
        // 按照 server.js 的新设计，serverStates.deviceName 会被包含在内
        if (serverStates.deviceName && serverStates.deviceName !== this.data.currentDevice.deviceName) {
            // 如果收到的状态不是当前正在查看的设备，则忽略
            return;
        }

        const motor1TextMap = {
            '1': '上通风口开运行状态',
            '2': '上通风口开停止状态',
            '3': '上通风口关运行状态',
            '4': '上通风口关停止状态',
            'unknown': '状态未知'
        };
        const motor2TextMap = {
            '1': '下通风口开运行状态',
            '2': '下通风口开停止状态',
            '3': '下通风口关运行状态',
            '4': '下通风口关停止状态',
            'unknown': '状态未知'
        };

        if (serverStates.motorA) {
            const state = serverStates.motorA;
            const physState = state.physicalState || 'unknown'; 
            this.setData({
                'motorA.isRunning': state.isRunning,
                'motorA.progress': state.currentPosition,
                'motorA.runningState': physState,
                'motorA.runningStateText': state.physicalStateText, 
                
                'device_properties.motor1': physState,
                'device_properties_text.motor1_text': motor1TextMap[physState] || '状态未知'
            });
        }
        if (serverStates.motorB) {
            const state = serverStates.motorB;
            const physState = state.physicalState || 'unknown'; 
             this.setData({
                'motorB.isRunning': state.isRunning,
                'motorB.progress': state.currentPosition,
                'motorB.runningState': physState,
                'motorB.runningStateText': state.physicalStateText, 

                'device_properties.motor2': physState,
                'device_properties_text.motor2_text': motor2TextMap[physState] || '状态未知'
            });
        }
    },
    
    onCalibrate(event) {
        const { motor, position } = event.currentTarget.dataset; const motorState = motor === 'A' ? this.data.motorA : this.data.motorB; const positionText = position === '0' ? '全关(0%)' : '全开(100%)'; const motorName = motor === 'A' ? '电机A' : '电机B'; if (motorState.isRunning) { wx.showToast({ title: '运行中无法校准', icon: 'none' }); return; } wx.showModal({ title: '确认校准', content: `强制设 ${motorName} 为 ${positionText}?`, success: (res) => { if (res.confirm) this.sendCalibrationRequest(motor, position); } });
    },
    
    sendCalibrationRequest(motor, position) {
        wx.showLoading({ title: '正在校准...' }); 
        wx.request({ 
            url: `${config.server_base_url}/api/set-motor-position`, 
            method: 'POST', 
            data: { deviceName: this.data.currentDevice.deviceName, motor: motor, position: Number(position) }, 
            success: (res) => { 
                wx.hideLoading(); 
                if (res.statusCode === 200 && res.data.success) { 
                    wx.showToast({ title: '校准成功', icon: 'success' }); 
                } else wx.showModal({ title: '校准失败', content: res.data.message || '服务器错误', showCancel: false }); 
            }, 
            fail: (err) => { 
                wx.hideLoading(); 
                wx.showModal({ title: '网络错误', content: '无法连接服务器', showCancel: false }); 
            } 
        });
    },
});