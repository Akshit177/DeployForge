FROM node:20-alpine

WORKDIR /app

# Install git and docker-cli for repository cloning and container management
RUN apk add --no-cache git docker-cli

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=3000
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
