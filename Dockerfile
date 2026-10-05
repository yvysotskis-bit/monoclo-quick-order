FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY scripts ./scripts
ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "server/index.js"]
