# Stack: Next 14 + TS. Nada pago.
FROM node:20-alpine AS base
# Prisma necesita OpenSSL en Alpine (si no, falla `prisma generate`).
RUN apk add --no-cache openssl libc6-compat
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
RUN npx prisma generate
EXPOSE 3000
# En compose se pisa CMD (dev / workers). Para prod Vercel: npm run build + start.
CMD ["npm", "run", "dev"]
