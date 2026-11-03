# World of DODO: local test image. On Zerops the same steps run from zerops.yaml (no Docker there).
# Stage 1 builds the game page (Vite, TypeScript, Babylon.js); stage 2 runs the server with the built page only.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY vite.config.mts ./
COPY tools/compress.js ./tools/
COPY client ./client
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY client/shared ./client/shared
COPY --from=build /app/client/dist ./client/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "server/server.js"]
