FROM node:20-alpine

ARG TARGETARCH

RUN apk add --no-cache docker-cli docker-cli-compose curl && \
    if [ "$TARGETARCH" = "arm64" ]; then \
        CADDY_FILTER=linux_arm64.tar.gz; \
    else \
        CADDY_FILTER=linux_amd64.tar.gz; \
    fi && \
    CADDY_URL=$(curl -fsSL "https://api.github.com/repos/caddyserver/caddy/releases/latest" \
      | grep browser_download_url | grep "$CADDY_FILTER" | cut -d'"' -f4 | head -1) && \
    curl -fsSL "$CADDY_URL" -o /tmp/caddy.tar.gz && \
    tar xzf /tmp/caddy.tar.gz -C /usr/local/bin caddy && \
    rm /tmp/caddy.tar.gz && \
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
