FROM node:22-alpine

WORKDIR /app

# Install deps first (layer cache)
COPY package.json .
RUN npm install --omit=dev

# Copy app files
COPY server.js .
COPY www/ ./www/

# Data directory for persistent config
RUN mkdir -p /app/data

EXPOSE 8484

LABEL org.opencontainers.image.title="XMB Homelab Dashboard"
LABEL org.opencontainers.image.description="PS3 XMB-style homelab dashboard with admin settings UI"

CMD ["node", "server.js"]
