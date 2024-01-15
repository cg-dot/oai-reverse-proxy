# Deploy to Render.com

**⚠️ This method is no longer recommended.  Please use the [self-hosting instructions](./self-hosting.md) instead.**

Render.com offers a free tier that includes 750 hours of compute time per month.  This is enough to run a single proxy instance 24/7.  Instances shut down after 15 minutes without traffic but start up again automatically when a request is received.  You can use something like https://app.checklyhq.com/ to ping your proxy every 15 minutes to keep it alive.

### 1. Create account
- [Sign up for Render.com](https://render.com/) to create an account and access the dashboard.

### 2. Create a service using a Blueprint
Render allows you to deploy and auutomatically configure a repository containing a [render.yaml](../render.yaml) file using its Blueprints feature.  This is the easiest way to get started.

- Click the **Blueprints** tab at the top of the dashboard.
- Click **New Blueprint Instance**.
- Under **Public Git repository**, enter `https://gitlab.com/khanon/oai-proxy`.
  - Note that this is not the GitGud repository, but a mirror on GitLab.
- Click **Continue**.
- Under **Blueprint Name**, enter a name.
- Under **Branch**, enter `main`.
- Click **Apply**.

The service will be created according to the instructions in the `render.yaml` file.  Don't wait for it to complete as it will fail due to missing environment variables.  Instead, proceed to the next step.

### 3. Set environment variables
- Return to the **Dashboard** tab.
- Click the name of the service you just created, which may show as "Deploy failed".
- Click the **Environment** tab.
- Click **Add Secret File**.
- Under **Filename**, enter `.env`.
- Under **Contents**, enter all of your environment variables, one per line, in the format `NAME=value`.
  - For example, `OPENAI_KEY=sk-abc123`.
- Click **Save Changes**.

**IMPORTANT:** Set `TRUSTED_PROXIES=3`, otherwise users' IP addresses will not be recorded correctly (the server will see the IP address of Render's load balancer instead of the user's real IP address).

The service will automatically rebuild and deploy with the new environment variables.  This will take a few minutes.  The link to your deployed proxy will appear at the top of the page.

If you want to change the URL, go to the **Settings** tab of your Web Service and click the **Edit** button next to **Name**.  You can also set a custom domain, though I haven't tried this yet.

# Optional

## Updating the server

To update your server, go to the page for your Web Service and click **Manual Deploy** > **Deploy latest commit**.  This will pull the latest version of the code and redeploy the server.

_If you have trouble with this, you can also try selecting **Clear build cache & deploy** instead from the same menu._

## Adding a greeting message

To show a greeting message on the Server Info page, set the `GREETING_URL` environment variable within Render to the URL of a Markdown file.  This URL should point to a raw text file, not an HTML page. You can use a public GitHub Gist or GitLab Snippet for this.  For example: `GREETING_URL=https://gitlab.com/-/snippets/2542011/raw/main/greeting.md`.  You can change the title of the page by setting the `SERVER_TITLE` environment variable.

Don't set `GREETING_URL` in the `.env` secret file you created earlier; it must be set in Render's environment variables section for it to work correctly.

## Customizing the server

You can customize the server by editing the `.env` configuration you created earlier. Refer to [.env.example](../.env.example) for a list of all available configuration options. Further information can be found in the [config.ts](../src/config.ts) file.
