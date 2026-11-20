# ==========================================
# STAGE 1: Builder
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

# Copy dependency definitions
COPY package*.json tsconfig.json ./

# Install all dependencies (termasuk devDependencies untuk compile TypeScript)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Compile TypeScript ke JavaScript (output di folder /app/dist)
RUN npm run build

# ==========================================
# STAGE 2: Production Runner
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy package files dan install HANYA production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy hasil kompilasi dari stage builder
COPY --from=builder /app/dist ./dist

# Port AudioSocket
EXPOSE 9099

# Jalankan aplikasi compiled JS
CMD ["node", "dist/index.js"]
