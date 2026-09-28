# Auto-clipper - single container: Next.js app + ffmpeg + python/opencv
# for smart vertical reframing. Built for self-hosting (e.g. Coolify).

FROM node:20-bookworm-slim AS base

# --- system deps: ffmpeg for cutting/cropping/caption burn, python3 +
# opencv for face-tracked smart crop, yt-dlp for "paste a YouTube link" ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp

# --- node deps ---
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm install --omit=dev=false

# --- build ---
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- runtime ---
FROM base AS runner
ENV NODE_ENV=production
ENV STORAGE_DIR=/app/storage

# standalone Next.js output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts

RUN mkdir -p /app/storage/uploads /app/storage/work /app/storage/output

EXPOSE 3000
VOLUME ["/app/storage"]

CMD ["node", "server.js"]
