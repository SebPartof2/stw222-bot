FROM node:20-alpine

RUN apk add --no-cache tzdata

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/

CMD ["node", "src/bot.js"]
