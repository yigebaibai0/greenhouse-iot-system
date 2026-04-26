#!/bin/bash
# ============================================================
# 温室大棚 IoT 服务器 - 安装脚本
# 适用系统: Ubuntu 18.04+ / Debian 10+ / CentOS 7+
# ============================================================

set -e

echo "============================================"
echo "温室大棚 IoT 服务 - 自动安装脚本"
echo "============================================"

# 检测系统
if [ -f /etc/redhat-release ]; then
    PKG_MGR="yum"
elif [ -f /etc/debian_version ]; then
    PKG_MGR="apt-get"
else
    echo "不支持的操作系统"
    exit 1
fi

echo "[1/6] 更新系统软件包..."
if [ "$PKG_MGR" = "yum" ]; then
    yum update -y
elif [ "$PKG_MGR" = "apt-get" ]; then
    apt-get update -y
fi

echo "[2/6] 安装 Node.js 18.x..."
if [ "$PKG_MGR" = "yum" ]; then
    curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
    yum install -y nodejs
elif [ "$PKG_MGR" = "apt-get" ]; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
fi

echo "[3/6] 安装 SQLite3 及构建工具..."
if [ "$PKG_MGR" = "yum" ]; then
    yum install -y sqlite sqlite-devel make gcc gcc-c++
elif [ "$PKG_MGR" = "apt-get" ]; then
    apt-get install -y sqlite3 libsqlite3-dev make gcc g++
fi

echo "[4/6] 安装 PM2 进程管理器..."
npm install -g pm2

echo "[5/6] 安装项目依赖..."
cd "$(dirname "$0")"
npm install

echo "[6/6] 配置 PM2 开机自启..."
pm2 startup 2>/dev/null || true
pm2 save 2>/dev/null || true

echo ""
echo "============================================"
echo "✅ 安装完成!"
echo ""
echo "请编辑以下文件，填入你的真实配置:"
echo "  - server.js 中的 OneNET_CONFIG (product_id / auth_info)"
echo "  - config.js 中的 server_base_url / web_url"
echo "  - index.js 中的 WS_URL"
echo ""
echo "启动服务: bash start.sh"
echo "停止服务: pm2 stop wechat-iot"
echo "查看日志: pm2 logs wechat-iot"
echo "============================================"
