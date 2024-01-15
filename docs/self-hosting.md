# Quick self-hosting guide

Temporary guide for self-hosting. This will be improved in the future to provide more robust instructions and options. Provided commands are for Ubuntu.

This uses prebuilt Docker images for convenience. If you want to make adjustments to the code you can instead clone the repo and follow the Local Development guide in the [README](../README.md).

## Table of Contents
- [Requirements](#requirements)
- [Running the application](#running-the-application)
- [Setting up a reverse proxy](#setting-up-a-reverse-proxy)
  - [trycloudflare](#trycloudflare)
  - [nginx](#nginx)
    - [Example basic nginx configuration (no SSL)](#example-basic-nginx-configuration-no-ssl)
    - [Example with Cloudflare SSL](#example-with-cloudflare-ssl)
- [Updating/Restarting the application](#updatingrestarting-the-application)

## Requirements

- Docker
- Docker Compose
- A VPS with at least 512MB of RAM (1GB recommended)
- A domain name

If you don't have a VPS and domain name you can use TryCloudflare to set up a temporary URL that you can share with others. See [trycloudflare](#trycloudflare) for more information.

## Running the application

- Install Docker and Docker Compose
- Create a new directory for the application
  - This will contain your .env file, greeting file, and any user-generated files
- Execute the following commands:
  - ```
    touch .env
    touch greeting.md
    echo "OPENAI_KEY=your-openai-key" >> .env
    curl https://gitgud.io/khanon/oai-reverse-proxy/-/raw/main/docker/docker-compose-selfhost.yml -o docker-compose.yml
    ```
  - You can set further environment variables and keys in the `.env` file. See [.env.example](../.env.example) for a list of available options.
  - You can set a custom greeting in `greeting.md`. This will be displayed on the homepage.
- Run `docker compose up -d`

You can check logs with `docker compose logs -n 100 -f`.

The provided docker-compose file listens on port 7860 but binds to localhost only. You should use a reverse proxy to expose the application to the internet as described in the next section.

## Setting up a reverse proxy

Rather than exposing the application directly to the internet, it is recommended to set up a reverse proxy. This will allow you to use HTTPS and add additional security measures.

### trycloudflare

This will give you a temporary (72 hours) URL that you can use to let others connect to your instance securely, without having to set up a reverse proxy. If you are running the server on your home network, this is probably the best option.
- Install `cloudflared` following the instructions at [try.cloudflare.com](https://try.cloudflare.com/).
- Run `cloudflared tunnel --url http://localhost:7860`
- You will be given a temporary URL that you can share with others.

If you have a VPS, you should use a proper reverse proxy like nginx instead for a more permanent solution which will allow you to use your own domain name, handle SSL, and add additional security/anti-abuse measures.

### nginx

First, install nginx.
- `sudo apt update && sudo apt install nginx`

#### Example basic nginx configuration (no SSL)

- `sudo nano /etc/nginx/sites-available/oai.conf`
  - ```
    server {
        listen 80;
        server_name example.com;
    
        location / {
            proxy_pass http://localhost:7860;
        }
    }
    ```
  - Replace `example.com` with your domain name.
  - Ctrl+X to exit, Y to save, Enter to confirm.
- `sudo ln -s /etc/nginx/sites-available/oai.conf /etc/nginx/sites-enabled`
- `sudo nginx -t`
  - This will check the configuration file for errors.
- `sudo systemctl restart nginx`
  - This will restart nginx and apply the new configuration.

#### Example with Cloudflare SSL

This allows you to use a self-signed certificate on the server, and have Cloudflare handle client SSL. You need to have a Cloudflare account and have your domain set up with Cloudflare already, pointing to your server's IP address.

- Set Cloudflare to use Full SSL mode. Since we are using a self-signed certificate, don't use Full (strict) mode.
- Create a self-signed certificate:
  - `openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout /etc/ssl/private/nginx-selfsigned.key -out /etc/ssl/certs/nginx-selfsigned.crt`
- `sudo nano /etc/nginx/sites-available/oai.conf`
  - ```
    server {
        listen 443 ssl;
        server_name yourdomain.com www.yourdomain.com;
    
        ssl_certificate /etc/ssl/certs/nginx-selfsigned.crt;
        ssl_certificate_key /etc/ssl/private/nginx-selfsigned.key;
    
        # Only allow inbound traffic from Cloudflare
        allow 173.245.48.0/20;
        allow 103.21.244.0/22;
        allow 103.22.200.0/22;
        allow 103.31.4.0/22;
        allow 141.101.64.0/18;
        allow 108.162.192.0/18;
        allow 190.93.240.0/20;
        allow 188.114.96.0/20;
        allow 197.234.240.0/22;
        allow 198.41.128.0/17;
        allow 162.158.0.0/15;
        allow 104.16.0.0/13;
        allow 104.24.0.0/14;
        allow 172.64.0.0/13;
        allow 131.0.72.0/22;
        deny all;
    
        location / {
            proxy_pass http://localhost:7860;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
        }
    
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256';
        ssl_prefer_server_ciphers on;
        ssl_session_cache shared:SSL:10m;
    }
    ```
  - Replace `yourdomain.com` with your domain name.
  - Ctrl+X to exit, Y to save, Enter to confirm.
- `sudo ln -s /etc/nginx/sites-available/oai.conf /etc/nginx/sites-enabled`

## Updating/Restarting the application

After making an .env change, you need to restart the application for it to take effect.

- `docker compose down`
- `docker compose up -d`

To update the application to the latest version:

- `docker compose pull`
- `docker compose down`
- `docker compose up -d`
- `docker image prune -f`
