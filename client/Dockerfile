FROM node:24.22.3-bookworm-slim AS build

WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client ./
RUN npm run build

FROM nginx:1.30.7-alpine3.24
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /client/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/readyz || exit 1
