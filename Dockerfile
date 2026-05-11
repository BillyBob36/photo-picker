# Photo Picker — Dockerfile pour Coolify.
# Inclut Chromium pour Puppeteer (scrape + screenshot recapture) et Sharp.
#
# Volume attendu (Coolify) :
#   /data  : monté en lecture-écriture, partagé avec outil-coiffure.
#            On y trouve salons.db, /screenshots/, /hero-images/, et notre photo-picker.db.

FROM node:20-slim AS base

# Dépendances système : libs Chromium + libs Sharp/libvips
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-freefont-ttf \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libasound2 libpangocairo-1.0-0 libpango-1.0-0 \
  && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Le serveur écoute sur 4000 par défaut, mais Coolify peut passer $PORT.
EXPOSE 4000

# Dossier où photo-picker écrira sa DB locale (sur le volume partagé).
ENV PICKER_DB_PATH=/data/photo-picker.db
ENV HERO_IMAGES_DIR=/data/hero-images
ENV SCREENSHOTS_DIR=/data/screenshots
ENV OUTIL_DB_PATH=/data/salons.db
ENV NODE_ENV=production

CMD ["node", "server.js"]
