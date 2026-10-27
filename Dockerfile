# Build with Bun (the repo's lockfile), run on plain Node with only the built app and pg.
FROM oven/bun:1.3.13-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Runtime dependencies (pg and its own) at the lockfile's versions.
FROM oven/bun:1.3.13-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile --ignore-scripts

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY bin ./bin
COPY --from=build /app/build ./build
USER node
EXPOSE 3000
# Set DATABASE_URL to pin the app to one database; put authentication in front of it.
CMD ["node", "bin/superbase.js", "--no-open"]
