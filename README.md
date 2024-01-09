# OAI Reverse Proxy

Reverse proxy server for various LLM APIs.

### Table of Contents
- [What is this?](#what-is-this)
- [Features](#features)
- [Usage Instructions](#usage-instructions)
  - [Self-hosting (locally or without Docker)](#self-hosting-locally-or-without-docker)
  - [Self hosting (with Docker)](#self-hosting-with-docker)
  - [Huggingface (not advised)](#huggingface-not-advised)
  - [Render (not advised)](#render-not-advised)
- [Local Development](#local-development)

## What is this?
This project allows you to run a reverse proxy server for various LLM APIs.

## Features
- [x] Support for multiple APIs
  - [x] [OpenAI](https://openai.com/)
  - [x] [Anthropic](https://www.anthropic.com/)
  - [x] [AWS Bedrock](https://aws.amazon.com/bedrock/)
  - [x] [Google MakerSuite/Gemini API](https://ai.google.dev/)
  - [x] [Azure OpenAI](https://azure.microsoft.com/en-us/products/ai-services/openai-service)
- [x] Translation from OpenAI-formatted prompts to any other API, including streaming responses
- [x] Multiple API keys with rotation and rate limit handling
- [x] Basic user management
  - [x] Simple role-based permissions
  - [x] Per-model token quotas
  - [x] Temporary user accounts
- [x] Prompt and completion logging
- [x] Abuse detection and prevention

---

## Usage Instructions
If you'd like to run your own instance of this server, you'll need to deploy it somewhere and configure it with your API keys. A few easy options are provided below, though you can also deploy it to any other service you'd like if you know what you're doing and the service supports Node.js.

### Self-hosting (locally or without Docker)
Follow the "Local Development" instructions below to set up prerequisites and start the server. Then you can use a service like [ngrok](https://ngrok.com/) or [trycloudflare.com](https://trycloudflare.com/) to securely expose your server to the internet, or you can use a more traditional reverse proxy/WAF like [Cloudflare](https://www.cloudflare.com/) or [Nginx](https://www.nginx.com/).

**Ensure you set the `TRUSTED_PROXIES` environment variable according to your deployment.** Refer to [.env.example](./.env.example) and [config.ts](./src/config.ts) for more information.

### Self hosting (with Docker)
If you have a Docker-capable VPS or server, use the Huggingface Dockerfile ([./docker/huggingface/Dockerfile](./docker/huggingface/Dockerfile)) to build an image and run it on your server.

**Ensure you set the `TRUSTED_PROXIES` environment variable according to your deployment.** Refer to [.env.example](./.env.example) and [config.ts](./src/config.ts) for more information.

### Alternatives
Fiz and Sekrit are working on some alternative ways to deploy this conveniently. While I'm not directly involved in writing code or scripts for that project, I'm providing some advice and will include links to their work here when it's ready. 

### Huggingface (not advised)
[See here for instructions on how to deploy to a Huggingface Space.](./docs/deploy-huggingface.md)

### Render (not advised)
[See here for instructions on how to deploy to Render.com.](./docs/deploy-render.md)

## Local Development
To run the proxy locally for development or testing, install Node.js >= 18.0.0 and follow the steps below.

1. Clone the repo
2. Install dependencies with `npm install`
3. Create a `.env` file in the root of the project and add your API keys. See the [.env.example](./.env.example) file for an example.
4. Start the server in development mode with `npm run start:dev`.

You can also use `npm run start:dev:tsc` to enable project-wide type checking at the cost of slower startup times. `npm run type-check` can be used to run type checking without starting the server.
