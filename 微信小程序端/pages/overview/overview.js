const { devices, config } = require('../../utils/config.js');
const util = require('../../utils/util.js');

Page({
    data: {
      deviceDataList: [],
      isLoading: true,
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

    fetchAllDeviceData() {
      const promises = this.data.deviceDataList.map((device, index) => {
        return Promise.all([
          util.fetchDeviceProperties(device.deviceName).then(data => {
            this.setData({
              [`deviceDataList[${index}].properties`]: data.properties,
              [`deviceDataList[${index}].last_updated`]: data.last_updated,
            });
          }).catch(() => {}),
          util.fetchDeviceStatus(device.deviceName).then(status => {
            this.setData({
              [`deviceDataList[${index}].online_status`]: status
            });
          }).catch(() => {})
        ]);
      });
      Promise.all(promises).then(() => {
        this.setData({ isLoading: false });
      });
    },

    navigateToDetail(e) {
      const index = e.currentTarget.dataset.index;
      wx.navigateTo({ url: `/pages/index/index?deviceIndex=${index}` });
    },

    navigateToDataWeb() {
      const url = config.web_url;
      if (!url) {
        wx.showToast({ title: '未配置网页地址', icon: 'none' });
        return;
      }
      wx.navigateTo({
        url: `/pages/webview/webview?url=${encodeURIComponent(url)}`
      });
    }
});
