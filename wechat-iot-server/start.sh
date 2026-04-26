#!/bin/bash
cd "$(dirname "$0")"
pm2 start server.js --name wechat-iot
pm2 save
echo "服务已启动，监听端口 8081"
