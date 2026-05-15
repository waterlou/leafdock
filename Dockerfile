FROM node:20-alpine

RUN apk add --no-cache docker-cli && \
    wget -qO /usr/local/bin/docker-compose "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" && \
    chmod +x /usr/local/bin/docker-compose && \
    mkdir -p /usr/lib/docker/cli-plugins && \
    ln -s /usr/local/bin/docker-compose /usr/lib/docker/cli-plugins/docker-compose

RUN case $(uname -m) in \
      x86_64) CARCH=amd64 ;; \
      aarch64) CARCH=arm64 ;; \
      *) CARCH=amd64 ;; \
    esac && \
    wget -qO- "https://github.com/caddyserver/caddy/releases/latest/download/caddy_linux_${CARCH}.tar.gz" | tar xz -C /usr/local/bin caddy

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
