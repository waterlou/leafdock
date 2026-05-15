FROM node:20-alpine

RUN apk add --no-cache docker-cli && \
    wget -qO /usr/local/bin/docker-compose "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" && \
    chmod +x /usr/local/bin/docker-compose && \
    mkdir -p /usr/lib/docker/cli-plugins && \
    ln -s /usr/local/bin/docker-compose /usr/lib/docker/cli-plugins/docker-compose

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json ./
COPY src/ src/

RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

ENV PORT=3001
ENV DATA_DIR=/data
ENV CADDY_ADMIN_URL=http://caddy:2019
ENV DOCKER_SOCKET=/var/run/docker.sock

RUN mkdir -p /data/apps /data/landing

VOLUME ["/data"]

EXPOSE 3001

CMD ["node", "dist/index.js"]
