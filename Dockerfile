FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++    # bcrypt compila nativo
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 8080
CMD ["sh", "-c", "node scripts/migrate.js && node src/server.js"]
