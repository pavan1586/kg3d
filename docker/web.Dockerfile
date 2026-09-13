# syntax=docker/dockerfile:1

# --- build the demo app and both packages ---
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/react/package.json packages/react/
COPY apps/demo/package.json apps/demo/
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build -w @kg3d/core \
 && npm run build -w @kg3d/react \
 && npm run build -w @kg3d/demo

# --- serve ---
FROM nginx:1.27-alpine
COPY --from=build /app/apps/demo/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
