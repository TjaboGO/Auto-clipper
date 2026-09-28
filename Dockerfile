# Auto-clipper - single container: Next.js app + ffmpeg + python/opencv
# for smart vertical reframing. Built for self-hosting (e.g. Coolify).

FROM node:22-bookworm-slim AS base

# --- system deps: ffmpeg for cutting/cropping/caption burn, python3 +
# opencv for face-tracked smart crop, yt-dlp for "paste a YouTube link",
# curl for the container health check ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# yt-dlp is left unpinned on purpose: YouTube changes often, and a rebuild
# should pick up the latest fixes. [default] includes the YouTube challenge
# solver, which runs on a JavaScript runtime - the image's Node works (yt-dlp
# needs Node 22+, one reason the base image is node:22).
COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt \
    && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default]" \
    && printf -- '--js-runtimes node\n' > /etc/yt-dlp.conf

# --- node deps ---
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# --- build ---
FROM base AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public && npm run build

# --- runtime ---
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV STORAGE_DIR=/app/storage
# Docker sets HOSTNAME to the container id, and the standalone server binds
# to $HOSTNAME - so set it explicitly to listen on all interfaces.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# standalone Next.js output, plus the files the server reads at runtime
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/assets ./assets

RUN mkdir -p /app/storage/uploads /app/storage/work /app/storage/output

EXPOSE 3000
VOLUME ["/app/storage"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD curl -fsS -o /dev/null http://127.0.0.1:3000/ || exit 1

CMD ["node", "server.js"]
