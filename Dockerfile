# Hysteria Backend - Docker Image
FROM node:20-alpine

WORKDIR /app

# System dependencies: mongodb-tools for backups; libstdc++/libgcc are required
# by the DuckDB native binding used by the access-logs analytics pipeline.
RUN apk add --no-cache mongodb-tools libstdc++ libgcc

# Копируем зависимости
COPY package*.json ./

# Устанавливаем зависимости
RUN npm install --omit=dev

# Копируем исходники
COPY . .

# Create directories for logs, certificates, backups and access-logs data.
RUN mkdir -p logs greenlock.d/live greenlock.d/accounts backups data/access-logs && \
    chmod -R 755 greenlock.d backups data

# Порты
EXPOSE 8444 80 443

# Запуск
CMD ["node", "index.js"]

