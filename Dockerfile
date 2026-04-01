FROM node:18-alpine

WORKDIR /app

# Copy package files and install production dependencies
COPY package*.json ./
RUN npm install --production

# Copy application code
COPY . .

# Self-host frontend JS dependencies (no CDN needed at runtime)
# Downloads happen at build time — users never hit external servers
RUN apk add --no-cache curl && \
    curl -sL https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js \
         -o public/qrcode.min.js && \
    curl -sL https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js \
         -o public/chart.umd.min.js && \
    apk del curl

RUN mkdir -p /lnd

EXPOSE 3001

CMD ["node", "server.js"]
