FROM node:20-alpine

# Default amd64 so classic `docker build` works; arm64 set by buildx.
# Note: arm/v7 is not covered (amd64 fallback) — requires buildx.
ARG TARGETARCH=amd64

RUN apk add --no-cache docker-cli docker-cli-compose curl && \
    if [ "$TARGETARCH" = "arm64" ]; then \
        CADDY_ARCH=arm64; \
    else \
        CADDY_ARCH=amd64; \
    fi && \
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_linux_${CADDY_ARCH}.tar.gz" -o /tmp/caddy.tar.gz && \
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
