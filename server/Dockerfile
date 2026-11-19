FROM node:24.22.3-bookworm-slim

ENV NODE_ENV=production \
    APP_ENV=production \
    PORT=3001

WORKDIR /app
COPY --chown=node:node server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server/src ./src

USER node
EXPOSE 3001
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/readyz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["npm", "start"]
