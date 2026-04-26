// pages/overview/overview.js

const { devices } = require('../../utils/config.js');
// --- 修改：引入重构后的 util.js 中的所有函数 ---
const util = require('../../utils/util.js');

Page({
    data: {
      deviceDataList: [],
      timer: null
    },
  
    onLoad(options) {
      this.setData({
        deviceDataList: devices.map(device => ({
          ...device, online_status: '查询中...', properties: null, last_updated: 'N/A'
        }))
      });
    },
  
    onShow() {
      this.fetchAllDeviceData();
      this.data.timer = setInterval(() => { this.fetchAllDeviceData(); }, 10000);
    },
  
    onHide() {
      if (this.data.timer) clearInterval(this.data.timer);
    },
  
    onUnload() {
      if (this.data.timer) clearInterval(this.data.timer);
    },
  
    // --- 修改：使用 util.js 中的函数来获取数据，代码更清晰 ---
    fetchAllDeviceData() {
      this.data.deviceDataList.forEach((device, index) => {
        // 调用通用函数获取设备属性
        util.fetchDeviceProperties(device.deviceName).then(data => {
          this.setData({
            [`deviceDataList[${index}].properties`]: data.properties,
            [`deviceDataList[${index}].last_updated`]: data.last_updated,
          });
        });

        // 调用通用函数获取设备状态
        util.fetchDeviceStatus(device.deviceName).then(status => {
          this.setData({
            [`deviceDataList[${index}].online_status`]: status
          });
        });
      });
    },
  
    // --- 移除：本地的 formatTime, fetchDeviceProperties, fetchDeviceStatus 函数已被删除 ---

    navigateToDetail(e) {
      const index = e.currentTarget.dataset.index;
      wx.navigateTo({ url: `/pages/index/index?deviceIndex=${index}` });
    },

    navigateToDataWeb() {
      const { config } = require('../../utils/config.js');
      const url = config.web_url; 
      if (!url) {
        wx.showToast({ title: '未配置网页地址', icon: 'none' });
        return;
      }
      wx.navigateTo({
        url: `/pages/webview/webview?url=${encodeURIComponent(url)}`
      });
    },

    stopPropagation() {
      // 这个函数依然保留，用于 wxml 中阻止事件冒泡
    }
});