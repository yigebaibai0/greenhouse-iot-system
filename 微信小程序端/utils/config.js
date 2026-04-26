const devices = [
    { name: "一号大棚", deviceName: "MY4G" },
    { name: "二号大棚", deviceName: "MY4G2" },
    { name: "三号大棚", deviceName: "MY4G3" },
    { name: "四号大棚", deviceName: "MY4G4" },
  ];

  const config = {
    auth_info: "YOUR_AUTH_INFO",
    product_id: "YOUR_PRODUCT_ID",
    api_base_url: "https://iot-api.heclouds.com",
    identifiers: {
      MOTOR: 'LED'
    },

    // ⚠️ 部署后请替换为你的服务器地址
    // 格式: http://你的服务器IP:端口号 (注意 http 不是 https，除非你配置了SSL)
    server_base_url: "http://YOUR_SERVER_IP:8081",
    web_url: "http://YOUR_SERVER_IP:8081"
  };

  module.exports = {
    devices: devices,
    config: config
  };
