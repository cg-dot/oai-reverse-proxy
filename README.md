# OAI Reverse Proxy

Reverse proxy server for various LLM APIs.

### Table of Contents
- [What is this?](#what-is-this)
- [Features](#features)
- [Usage Instructions](#usage-instructions)
  - [Self-hosting](#self-hosting)
  - [Alternatives](#alternatives)
    - [Huggingface (outdated, not advised)](#huggingface-outdated-not-advised)
    - [Render (outdated, not advised)](#render-outdated-not-advised)
- [Local Development](#local-development)

## What is this?
This project allows you to run a reverse proxy server for various LLM APIs.

## Features
- [x] Support for multiple APIs
  - [x] [OpenAI](https://openai.com/)
  - [x] [Anthropic](https://www.anthropic.com/)
  - [x] [AWS Bedrock](https://aws.amazon.com/bedrock/)
  - [x] [Vertex AI (GCP)](https://cloud.google.com/vertex-ai/)
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

### Self-hosting
[See here for instructions on how to self-host the application on your own VPS or local machine.](./docs/self-hosting.md)

**Ensure you set the `TRUSTED_PROXIES` environment variable according to your deployment.** Refer to [.env.example](./.env.example) and [config.ts](./src/config.ts) for more information.

### Alternatives
Fiz and Sekrit are working on some alternative ways to deploy this conveniently. While I'm not involved in this effort beyond providing technical advice regarding my code, I'll link to their work here for convenience: [Sekrit's rentry](https://rentry.org/sekrit)  

### Huggingface (outdated, not advised)
[See here for instructions on how to deploy to a Huggingface Space.](./docs/deploy-huggingface.md)

### Render (outdated, not advised)
[See here for instructions on how to deploy to Render.com.](./docs/deploy-render.md)

## Local Development
To run the proxy locally for development or testing, install Node.js >= 18.0.0 and follow the steps below.

1. Clone the repo
2. Install dependencies with `npm install`
3. Create a `.env` file in the root of the project and add your API keys. See the [.env.example](./.env.example) file for an example.
4. Start the server in development mode with `npm run start:dev`.

You can also use `npm run start:dev:tsc` to enable project-wide type checking at the cost of slower startup times. `npm run type-check` can be used to run type checking without starting the server.

## Building
To build the project, run `npm run build`. This will compile the TypeScript code to JavaScript and output it to the `build` directory.

Note that if you are trying to build the server on a very memory-constrained (<= 1GB) VPS, you may need to run the build with `NODE_OPTIONS=--max_old_space_size=2048 npm run build` to avoid running out of memory during the build process, assuming you have swap enabled.  The application itself should run fine on a 512MB VPS for most reasonable traffic levels.

## Forking

If you are forking the repository on GitGud, you may wish to disable GitLab CI/CD or you will be spammed with emails about failed builds due not having any CI runners. You can do this by going to *Settings > General > Visibility, project features, permissions* and then disabling the "CI/CD" feature.
