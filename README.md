---
title: oai-reverse-proxy
emoji: 🔁
colorFrom: green
colorTo: purple
sdk: docker
pinned: false
---
# OAI Reverse Proxy Server

Simple reverse proxy server for the OpenAI API.

## What is this?
If you have an API key you want to share with a friend, you can use this to keep your key safe while still allowing them to generate text with the API.

## Why?
OpenAI keys have full permissions to themselves. They can revoke themselves, generate new keys, modify your spend quotas, and so forth. You absolutely should not share them.

So, if you still want to share access to your key, you can use this to do so safely.  You can also set a separate key just for this proxy server if you want to gatekeep access.

## How to use

### 1. Get an API key
- Go to [OpenAI](https://openai.com/) and sign up for an account.
### 2. Clone this Huggingface repository to your account
- Go to [Huggingface](https://huggingface.co/) and sign up for an account.
- Once logged in, click on the `+` button in the top right corner and select `Duplicate Space`.
### 3. Set your OpenAI API key as a secret
- Click the Settings button in the top right corner of your repository.
- Scroll down to the `Secrets` section and click `New Secret`.
- Enter `OPENAI_API_KEY` as the name and your OpenAI API key as the value.

**Do not paste the key into `server.js`!** That file is public and anyone can see it. Leave it alone; it will load the key from the secret you just created.
### 4. Deploy the server
- Click the `Deploy` button in the top right corner of your repository.
### 5. Share the link
