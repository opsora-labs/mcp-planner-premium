# --- build stage ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ---
FROM node:22-slim AS runtime
ENV NODE_ENV=production

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node --from=build /app/dist ./dist

# DATAVERSE_ORG_URL and TENANT_ID must be supplied at deploy time; see README.
# TLS is terminated at the cloud ingress (ACA / reverse proxy) — the container
# only receives plain HTTP, so a non-privileged port and no Linux capabilities
# are needed.
ENV PORT=3000
EXPOSE 3000

# Drop root; the official node image ships a non-privileged `node` user.
USER node

# Node receives SIGTERM as PID 1 because index.ts registers explicit handlers,
# so graceful shutdown works without an init shim. For zombie reaping, run the
# container with an init process (docker `--init`, or enable it in the Azure
# Container Apps revision) - belt-and-suspenders, not required for shutdown.
CMD ["node", "dist/index.js"]
