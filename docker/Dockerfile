FROM node:18-bullseye-slim

RUN apt-get update && \
    apt-get install -y git

RUN git clone https://github.com/nai-degen/oai-reverse-proxy.git /app

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 7860

CMD [ "npm", "start" ]
