# ---- 构建前端（Vite + Vue3 + Naive UI） ----
FROM node:20-alpine AS build
WORKDIR /build
COPY web/ ./web/
RUN cd web && npm install && npm run build

# ---- 运行期：零依赖 Node 服务 ----
FROM node:20-alpine
WORKDIR /app

# 后端单文件（仅用 Node 内置模块，无需 node_modules）
COPY server.js ./

# 构建产物（单文件内联的 public/index.html）
COPY --from=build /build/public ./public

# 运行时数据（账号 / 配置 / 日志），由宿主机挂载
RUN mkdir -p /app/data

ENV HOST=0.0.0.0 \
    PORT=8788 \
    PANEL_OPEN_BROWSER=0

EXPOSE 8788

CMD ["node", "server.js"]
