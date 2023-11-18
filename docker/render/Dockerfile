# syntax = docker/dockerfile:1.2

FROM node:18-bullseye-slim
RUN apt-get update && \
    apt-get install -y curl
    
# Unlike Huggingface, Render can only deploy straight from a git repo and
# doesn't allow you to create or modify arbitrary files via the web UI.
# To use a greeting file, set `GREETING_URL` to a URL that points to a raw
# text file containing your greeting, such as a GitHub Gist.

# You may need to clear the build cache if you change the greeting, otherwise
# Render will use the cached layer from the previous build.

WORKDIR /app
ARG GREETING_URL
RUN if [ -n "$GREETING_URL" ]; then \
    curl -sL "$GREETING_URL" > greeting.md; \
    fi
COPY package*.json greeting.md* ./
RUN npm install
COPY . .
RUN npm run build
RUN --mount=type=secret,id=_env,dst=/etc/secrets/.env cat /etc/secrets/.env >> .env
EXPOSE 10000
ENV NODE_ENV=production
CMD [ "npm", "start" ]
