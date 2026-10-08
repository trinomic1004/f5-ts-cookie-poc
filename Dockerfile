FROM node:24-slim

# deps mínimas de Chrome en debian slim (no hace falta xvfb ni display)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app
COPY scripts/f5-ts-cookie-poc.mjs /app/

# --no-sandbox porque en container corremos como root
CMD ["node", "f5-ts-cookie-poc.mjs"]
