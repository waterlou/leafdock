FROM node:20-alpine

RUN apk add --no-cache docker-cli curl && \
    PLAT=$(uname -s | tr '[:upper:]' '[:lower:]') && \
    curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-${PLAT}-$(uname -m)" -o /usr/local/bin/docker-compose && \
    chmod +x /usr/local/bin/docker-compose && \
    mkdir -p /usr/lib/docker/cli-plugins && \
    ln -s /usr/local/bin/docker-compose /usr/lib/docker/cli-plugins/docker-compose && \
    case $(uname -m) in \
      x86_64) arch=amd64 ;; \
      aarch64) arch=arm64 ;; \
      *) arch=amd64 ;; \
    esac && \
    curl -fsSL "https://github.com/caddyserver/caddy/releases/latest/download/caddy_linux_${arch}.tar.gz" | tar xz -C /usr/local/bin caddy && \
    apk del curl

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json ./
COPY src/ src/

RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

COPY Caddyfile /etc/caddy/Caddyfile
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PORT=3001
ENV DATA_DIR=/data
ENV CADDY_ADMIN_URL=http://localhost:2019
ENV DOCKER_SOCKET=/var/run/docker.sock

RUN mkdir -p /data/apps /data/landing

VOLUME ["/data"]

EXPOSE 80
EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
