FROM node:20-alpine

WORKDIR /app

# Copy package files and install production dependencies as root,
# then ensure everything under /app is owned by the node user.
COPY package*.json ./
RUN npm install --production && \
    npm cache clean --force && \
    mkdir -p /app/data && \
    chown -R node:node /app

# Copy application code with correct ownership.
COPY --chown=node:node . .

# Self-host frontend JS dependencies (no CDN needed at runtime).
# Downloads happen at build time with SHA-256 checksum verification.
# Verified checksums (pin these if the upstream files ever change):
#   qrcode.min.js:    c541ef06327885a8415bca8df6071e14189b4855336def4f36db54bde8484f36
#   chart.umd.min.js: 0e2326c6868072bec1592760c6729043caeea2960a2b46cee6a2192aac6abff0
RUN apk add --no-cache curl && \
    curl -fsSL https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js \
         -o public/qrcode.min.js && \
    echo "c541ef06327885a8415bca8df6071e14189b4855336def4f36db54bde8484f36  public/qrcode.min.js" | sha256sum -c - && \
    curl -fsSL https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js \
         -o public/chart.umd.min.js && \
    echo "0e2326c6868072bec1592760c6729043caeea2960a2b46cee6a2192aac6abff0  public/chart.umd.min.js" | sha256sum -c - && \
    apk del curl

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)}).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
