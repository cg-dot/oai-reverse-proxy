---
title: oai-reverse-proxy
emoji: 🔁
colorFrom: green
colorTo: purple
sdk: docker
pinned: false
---
<!-- -->
# OAI Reverse Proxy

Reverse proxy server for the OpenAI API. Forwards text generation requests while rejecting administrative/billing requests. Includes optional rate limiting and prompt filtering to prevent abuse.

### Table of Contents
- [What is this?](#what-is-this)
- [Why?](#why)
- [Setup Instructions](#setup-instructions)
  - [Deploy to Huggingface (Recommended)](#deploy-to-huggingface-recommended)
  - [Deploy to Repl.it (WIP)](#deploy-to-replit-wip)

## What is this?
If you have an API key you want to share with a friend, you can use this to keep your key safe while still allowing them to generate text with the API.

You can also use this if you'd like to build a client-side application which uses the OpenAI, but don't want to build your own backend. You should never embed your real OpenAI API key in a client-side application. Instead, you can have your frontend connect to this reverse proxy and forward requests to OpenAI.

This keeps your keys safe and allows you to use the rate limiting and prompt filtering features of the proxy to prevent abuse.

## Why?
OpenAI keys have full account permissions. They can revoke themselves, generate new keys, modify spend quotas, etc. You absolutely should not share them, nor should you embed them in client-side applications as they can be easily stolen.

This proxy only forwards text generation requests to OpenAI and rejects requests which would otherwise modify your account. 

---

## Setup Instructions
Since this is a server, you'll need to deploy it somewhere.  A few options are available:

### Deploy to Huggingface (Recommended)
[See here for instructions on how to deploy to a Huggingface Space.](./docs/huggingface.md)

### Deploy to Repl.it (WIP)
Still working on this. It's a bit more technical than the Huggingface option; you can give it a shot by clicking on the button below.

[![Run on Repl.it](https://replit.com/badge/github/nai-degen/oai-reverse-proxy)](https://replit.com/new/github/nai-degen/oai-reverse-proxy)

You'll need to set your secrets in Replit similar to the Huggingface instructions above.  Currently .env files don't work properly so it only uses the default configuration.
