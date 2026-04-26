// utils/util.js

// --- 修改：从 config 中引入配置，以便在 util 中使用 ---
const { config } = require('./config.js');

/**
 * 格式化时间戳为 YYYY/MM/DD HH:mm:ss 格式
 * @param {string | number} timestamp - 毫秒时间戳
 */
const formatTime = timestamp => {
  if (!timestamp || timestamp === 0) return 'N/A';
  const date = new Date(Number(timestamp));
  const year = date.getFullYear();
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const day = date.getDate().toString().padStart(2, '0');
  const hour = date.getHours().toString().padStart(2, '0');
  const minute = date.getMinutes().toString().padStart(2, '0');
  const second = date.getSeconds().toString().padStart(2, '0');
  return `${year}/${month}/${day} ${hour}:${minute}:${second}`;
}

/**
 * --- 封装获取设备属性的通用函数 ---
 * @param {string} deviceName - 设备名称
 * @returns {Promise<object>} - 返回包含属性和最后更新时间的对象
 */
const fetchDeviceProperties = (deviceName) => {
  return new Promise((resolve, reject) => {
    const { api_base_url, product_id, auth_info } = config;
    wx.request({
      url: `${api_base_url}/thingmodel/query-device-property?product_id=${product_id}&device_name=${deviceName}`,
      method: "GET",
      header: { 'Authorization': auth_info },
      success: (res) => {
        if (res.data && res.data.code === 0 && Array.isArray(res.data.data) && res.data.data.length > 0) {
          const new_properties = {};
          res.data.data.forEach(item => {
            new_properties[item.identifier] = item.value;
          });
          const lastUpdatedTime = formatTime(res.data.data[0].time);
          resolve({ properties: new_properties, last_updated: lastUpdatedTime });
        } else {
          // 请求成功但无数据
          resolve({ properties: {}, last_updated: 'N/A' });
        }
      },
      fail: (err) => {
        reject(err);
      }
    });
  });
}

/**
 * --- 【重点修改】封装获取设备在线状态的通用函数 ---
 * @param {string} deviceName - 设备名称
 * @returns {Promise<string>} - 返回 '在线', '离线', 或 '查询失败'
 */
const fetchDeviceStatus = (deviceName) => {
  return new Promise((resolve) => {
    const { api_base_url, product_id, auth_info } = config;
    
    wx.request({
      // --- 【修改】API 路径错误，/device/status 导致 404 ---
      // ---    此平台正确的路径应为 /device/detail     ---
      url: `${api_base_url}/device/detail?product_id=${product_id}&device_name=${deviceName}`,
      method: "GET",
      header: { 'Authorization': auth_info },
      success: (res) => {
        // --- 【修改】解析 /device/detail 的返回结构 ---
        // 成功的返回示例: { "code": 0, "data": { "device_name": "MY4G", "status": 1, ... } }
        // "status": 1 表示在线, 0 (或其它) 表示离线
        // (这与你原始代码中 status-history 的解析逻辑保持一致)
        if (res.data && res.data.code === 0 && res.data.data) {
          // --- 【修改】检查 data.status 字段 (而不是 data.online) ---
          const statusText = res.data.data.status === 1 ? '在线' : '离线';
          resolve(statusText);
        } else {
          // code 不为 0 或 data 不存在，视为离线
          resolve('离线');
        }
      },
      fail: (err) => {
        console.error("获取设备状态失败:", err);
        resolve('查询失败');
      }
    });
  });
}

// 导出所有通用函数
module.exports = {
  formatTime,
  fetchDeviceProperties,
  fetchDeviceStatus
}