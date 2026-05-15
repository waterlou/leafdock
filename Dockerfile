FROM node:20-alpine

RUN apk add --no-cache docker-cli docker-cli-compose-plugin

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY dist/ dist/

ENV PORT=3001
ENV DATA_DIR=/data
ENV CADDY_ADMIN_URL=http://caddy:2019
ENV DOCKER_SOCKET=/var/run/docker.sock

RUN mkdir -p /data/apps /data/landing

VOLUME ["/data"]

EXPOSE 3001

CMD ["node", "dist/index.js"]
