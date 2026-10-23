# gx10-mon — 多階段：build 期打包，運行期只帶產物
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY public/index.html public/theme.css ./public/
ARG GIT_SHA=dev
ENV GIT_SHA=${GIT_SHA}
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# nvidia-smi 由宿主掛入（/usr/bin/nvidia-smi + /usr/lib/nvidia）
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY package.json ./
EXPOSE 8090
VOLUME /app/data
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HOST_PORT||8090)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings", "dist/server.js"]
