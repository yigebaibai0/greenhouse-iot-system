// pages/webview/webview.js
Page({
    data: {
      // 初始化一个空的 url，用于存储要复制的链接
      url: ''
    },
  
    onLoad(options) {
      // 页面加载时，获取从上一个页面（总览页）传递过来的网址参数
      if (options.url) {
        const decodedUrl = decodeURIComponent(options.url);
        
        // 您之前的代码逻辑，做一个替换检查，确保地址是正确的。
        // 这里我们保留这个逻辑，作为双重保险。
        const finalUrl = decodedUrl.replace(':3000', '');
        
        this.setData({
          url: finalUrl
        });
  
      } else {
        // 如果没有收到 url 参数，给一个错误提示
        wx.showToast({
          title: '网址链接不存在',
          icon: 'error'
        });
      }
    },
  
    // --- 新增：点击“复制链接”按钮时触发的函数 ---
    copyUrl() {
      if (this.data.url) {
        // 调用微信API，将链接设置到系统剪贴板
        wx.setClipboardData({
          data: this.data.url,
          success: (res) => {
            // 复制成功后的提示
            wx.showToast({
              title: '链接已复制',
              icon: 'success',
              duration: 2000
            });
          },
          fail: (err) => {
            // 复制失败的提示
            wx.showToast({
              title: '复制失败，请重试',
              icon: 'error',
              duration: 2000
            });
          }
        });
      } else {
        wx.showToast({
          title: '链接无效',
          icon: 'error'
        });
      }
    },
  
    /**
     * 用户点击右上角分享
     */
    onShareAppMessage() {
      // 自定义分享出去的卡片信息
      return {
        title: '温室大棚数据可视化中心',
        // 确保分享出去的路径也包含了正确的 url
        path: `/pages/webview/webview?url=${encodeURIComponent(this.data.url)}`
      }
    }
  })
  