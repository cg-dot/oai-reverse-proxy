FROM node:18-bullseye-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 7860

CMD [ "npm", "start" ]
