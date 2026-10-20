# tossinvest add-on for minitok
# Runs the autonomous trading bot inside a Node.js container with WTS exchange support.
FROM node:20-bookworm-slim

# Playwright/Chromium runtime dependencies + tzdata
RUN apt-get update && apt-get install -y --no-install-recommends \
    tzdata \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
    libcairo2 libasound2 libx11-6 libx11-xcb1 libxcb1 libxext6 \
    fonts-liberation fonts-unfonts-core \
    ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Timezone
RUN cp /usr/share/zoneinfo/Asia/Seoul /etc/localtime && echo "Asia/Seoul" > /etc/timezone

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Install Chromium browser for Playwright (used only when env UTK not set)
RUN npx playwright install --with-deps chromium || npx playwright install chromium

COPY . .

ENV TZ=Asia/Seoul
ENV NODE_ENV=production

CMD ["node", "runner.js"]
