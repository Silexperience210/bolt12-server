FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (npm install car pas de package-lock.json)
RUN npm install --production

# Copy application code
COPY . .

# Create directory for LND certs
RUN mkdir -p /lnd

EXPOSE 3000

CMD ["node", "server.js"]
