# Hack4Hack Team Formation — single container.
# Stage 1 builds the client (Vite) and the server (tsc), then copies the
# built client into server/public/, where the server serves it statically.
# Stage 2 ships only the production runtime: node, the server build, the
# static client, and production dependencies. No secrets are baked in —
# DATABASE_URL arrives as a hosting secret at runtime.

FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies first (cached unless a package.json changes).
COPY package.json package-lock.json ./
COPY server/package.json ./server/package.json
COPY client/package.json ./client/package.json
RUN npm ci

COPY server ./server
COPY client ./client

RUN npm run build -w client
RUN npm run build -w server
RUN mkdir -p server/public && cp -r client/dist/* server/public/

# Drop dev dependencies before the runtime stage copies node_modules.
RUN npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# npm workspaces hoist shared deps to the root node_modules; Node resolves
# them by walking up from server/dist, so the root copy is all we need.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/public ./server/public

EXPOSE 3000
CMD ["node", "server/dist/index.js"]
