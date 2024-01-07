FROM node:18-bullseye-slim
RUN apt-get update && \
    apt-get install -y git
RUN git clone https://gitgud.io/khanon/oai-reverse-proxy.git /app
WORKDIR /app
RUN chown -R 1000:1000 /app
USER 1000
RUN npm install
COPY Dockerfile greeting.md* .env* ./
RUN npm run build
EXPOSE 7860
ENV NODE_ENV=production
# Huggigface free VMs have 16GB of RAM so we can be greedy
ENV NODE_OPTIONS="--max-old-space-size=12882"
CMD [ "npm", "start" ]
