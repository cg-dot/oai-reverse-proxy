# User Management

The proxy supports several different user management strategies. You can choose the one that best fits your needs by setting the `GATEKEEPER` environment variable.

Several of these features require you to set secrets in your environment. If using Huggingface Spaces to deploy, do not set these in your `.env` file because that file is public and anyone can see it.

## Table of Contents

- [No user management](#no-user-management-gatekeepernone)
- [Single-password authentication](#single-password-authentication-gatekeeperproxy_key)
- [Per-user authentication](#per-user-authentication-gatekeeperuser_token)
  - [Memory](#memory)
  - [Firebase Realtime Database](#firebase-realtime-database)
    - [Firebase setup instructions](#firebase-setup-instructions)
- [Whitelisting admin IP addresses](#whitelisting-admin-ip-addresses)

## No user management (`GATEKEEPER=none`)

This is the default mode. The proxy will not require any authentication to access the server and offers basic IP-based rate limiting and anti-abuse features.

## Single-password authentication (`GATEKEEPER=proxy_key`)

This mode allows you to set a password that must be passed in the `Authentication` header of every request to the server as a bearer token. This is useful if you want to restrict access to the server, but don't want to create a separate account for every user.

To set the password, create a `PROXY_KEY` secret in your environment.

## Per-user authentication (`GATEKEEPER=user_token`)

This mode allows you to provision separate Bearer tokens for each user. You can manage users via the /admin/users via REST or through the admin interface at `/admin`.

To begin, set `ADMIN_KEY` to a secret value. This will be used to authenticate requests to the REST API or to log in to the UI.

[You can find an OpenAPI specification for the /admin/users REST API here.](openapi-admin-users.yaml)

By default, the proxy will store user data in memory. Naturally, this means that user data will be lost when the proxy is restarted, though you can use the user import/export feature to save and restore user data manually or via a script. However, the proxy also supports persisting user data to an external data store with some additional configuration.

Below are the supported data stores and their configuration options.

### Memory

This is the default data store (`GATEKEEPER_STORE=memory`) User data will be stored in memory and will be lost when the server is restarted. You are responsible for exporting and re-importing user data after a restart.

### Firebase Realtime Database

To use Firebase Realtime Database to persist user data, set the following environment variables:

- `GATEKEEPER_STORE`: Set this to `firebase_rtdb`
- **Secret** `FIREBASE_RTDB_URL`: The URL of your Firebase Realtime Database, e.g. `https://my-project-default-rtdb.firebaseio.com`
- **Secret** `FIREBASE_KEY`: A base-64 encoded service account key for your Firebase project. Refer to the instructions below for how to create this key.

**Firebase setup instructions**

1. Go to the [Firebase console](https://console.firebase.google.com/) and click "Add project", then follow the prompts to create a new project.
2. From the **Project Overview** page, click **All products** in the left sidebar, then click **Realtime Database**.
3. Click **Create database** and choose **Start in test mode**. Click **Enable**.
   - Test mode is fine for this use case as it still requires authentication to access the database. You may wish to set up more restrictive rules if you plan to use the database for other purposes.
   - The reference URL for the database will be displayed on the page. You will need this later.
4. Click the gear icon next to **Project Overview** in the left sidebar, then click **Project settings**.
5. Click the **Service accounts** tab, then click **Generate new private key**.
6. The downloaded file contains your key. Encode it as base64 and set it as the `FIREBASE_KEY` secret in your environment.
7. Set `FIREBASE_RTDB_URL` to the reference URL of your Firebase Realtime Database, e.g. `https://my-project-default-rtdb.firebaseio.com`.
8. Set `GATEKEEPER_STORE` to `firebase_rtdb` in your environment if you haven't already.

The proxy server will attempt to connect to your Firebase Realtime Database at startup and will throw an error if it cannot connect. If you see this error, check that your `FIREBASE_RTDB_URL` and `FIREBASE_KEY` secrets are set correctly.

## Whitelisting admin IP addresses
You can add your own IP ranges to the `ADMIN_WHITELIST` environment variable for additional security.

You can provide a comma-separated list containing individual IPv4 or IPv6 addresses, or CIDR ranges.

To whitelist an entire IP range, use CIDR notation. For example, `192.168.0.1/24` would whitelist all addresses from `192.168.0.0` to `192.168.0.255`.

To disable the whitelist, set `ADMIN_WHITELIST=0.0.0.0/0,::0`, which will allow access from any IPv4 or IPv6 address. This is the default behavior.
