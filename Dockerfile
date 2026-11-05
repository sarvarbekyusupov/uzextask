FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:26-bookworm-slim
WORKDIR /app
ENV HOST=0.0.0.0 PORT=3000 UZEX_DB=data/uzex.duckdb
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts ./scripts
COPY data/uzex.duckdb ./data/uzex.duckdb
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
