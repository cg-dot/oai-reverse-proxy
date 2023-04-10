---
title: oai-reverse-proxy
emoji: 🔁
colorFrom: green
colorTo: purple
sdk: docker
pinned: false
---
<!-- -->
# OAI Reverse Proxy Server

Simple reverse proxy server for the OpenAI API.


## What is this?
If you have an API key you want to share with a friend, you can use this to keep your key safe while still allowing them to generate text with the API.

## Why?
OpenAI keys have full account permissions. They can revoke themselves, generate new keys, modify spend quotas, etc. You absolutely should not share them.

If you still want to share access to your key, you can put it behind this proxy to ensure it can't be used to do anything but generate text.  You can also set a separate key on the proxy to gatekeep access.

## How to use
Since this is a server, you'll need to deploy it somewhere.  A few options are available:

### Deploy to Huggingface (Recommended)
[See here for instructions on deploying to a Huggingface Space.](./docs/huggingface.md)

### Deploy to Repl.it (WIP)
Still working on this. It's a bit more technical than the Huggingface option; you can give it a shot by clicking on the button below.

[![Run on Repl.it](https://replit.com/badge/github/nai-degen/oai-reverse-proxy)](https://replit.com/new/github/nai-degen/oai-reverse-proxy)

You'll need to set your secrets in Replit similar to the Huggingface instructions above.  Currently .env files don't work properly so it only uses the default configuration.
