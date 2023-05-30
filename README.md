# OAI Reverse Proxy

Reverse proxy server for the OpenAI and Anthropic APIs. Forwards text generation requests while rejecting administrative/billing requests. Includes optional rate limiting and prompt filtering to prevent abuse.

### Table of Contents
- [What is this?](#what-is-this)
- [Why?](#why)
- [Usage Instructions](#setup-instructions)
  - [Deploy to Huggingface (Recommended)](#deploy-to-huggingface-recommended)
  - [Deploy to Repl.it (WIP)](#deploy-to-replit-wip)
- [Local Development](#local-development)

## What is this?
If you would like to provide a friend access to an API via keys you own, you can use this to keep your keys safe while still allowing them to generate text with the API. You can also use this if you'd like to build a client-side application which uses the OpenAI or Anthropic APIs, but don't want to build your own backend. You should never embed your real API keys in a client-side application. Instead, you can have your frontend connect to this reverse proxy and forward requests to the downstream service.

This keeps your keys safe and allows you to use the rate limiting and prompt filtering features of the proxy to prevent abuse.

## Why?
OpenAI keys have full account permissions. They can revoke themselves, generate new keys, modify spend quotas, etc. **You absolutely should not share them, post them publicly, nor embed them in client-side applications as they can be easily stolen.**

This proxy only forwards text generation requests to the downstream service and rejects requests which would otherwise modify your account. 

---

## Usage Instructions
If you'd like to run your own instance of this proxy, you'll need to deploy it somewhere and configure it with your API keys. A few easy options are provided below, though you can also deploy it to any other service you'd like.

### Deploy to Huggingface (Recommended)
[See here for instructions on how to deploy to a Huggingface Space.](./docs/deploy-huggingface.md)

### Deploy to Render
[See here for instructions on how to deploy to Render.com.](./docs/deploy-render.md)

## Local Development
To run the proxy locally for development or testing, install Node.js >= 18.0.0 and follow the steps below.

1. Clone the repo
2. Install dependencies with `npm install`
3. Create a `.env` file in the root of the project and add your API keys. See the [.env.example](./.env.example) file for an example.
4. Start the server in development mode with `npm run start:dev`.

You can also use `npm run start:dev:tsc` to enable project-wide type checking at the cost of slower startup times. `npm run type-check` can be used to run type checking without starting the server.
