# Configuring the proxy for DALL-E

The proxy supports DALL-E 2 and DALL-E 3 image generation via the `/proxy/openai-images` endpoint. By default it is disabled as it is somewhat expensive and potentially more open to abuse than text generation.

- [Updating your Dockerfile](#updating-your-dockerfile)
- [Enabling DALL-E](#enabling-dall-e)
- [Setting quotas](#setting-quotas)
- [Rate limiting](#rate-limiting)

## Updating your Dockerfile
If you are using a previous version of the Dockerfile supplied with the proxy, it doesn't have the necessary permissions to let the proxy save temporary files.

You can replace the entire thing with the new Dockerfile at [./docker/huggingface/Dockerfile](../docker/huggingface/Dockerfile) (or the equivalent for Render deployments).

You can also modify your existing Dockerfile; just add the following lines after the `WORKDIR` line:

```Dockerfile
# Existing
RUN git clone https://gitgud.io/khanon/oai-reverse-proxy.git /app
WORKDIR /app

# Take ownership of the app directory and switch to the non-root user
RUN chown -R 1000:1000 /app
USER 1000

# Existing
RUN npm install
```

## Enabling DALL-E
Add `dall-e` to the `ALLOWED_MODEL_FAMILIES` environment variable to enable DALL-E. For example:

```
# GPT3.5 Turbo, GPT-4, GPT-4 Turbo, and DALL-E
ALLOWED_MODEL_FAMILIES=turbo,gpt-4,gpt-4turbo,dall-e

# All models as of this writing
ALLOWED_MODEL_FAMILIES=turbo,gpt4,gpt4-32k,gpt4-turbo,claude,gemini-pro,aws-claude,dall-e
```

Refer to [.env.example](../.env.example) for a full list of supported model families. You can add `dall-e` to that list to enable all models.

## Setting quotas
DALL-E doesn't bill by token like text generation models. Instead there is a fixed cost per image generated, depending on the model, image size, and selected quality.

The proxy still uses tokens to set quotas for users. The cost for each generated image will be converted to "tokens" at a rate of 100000 tokens per US$1.00. This works out to a similar cost-per-token as GPT-4 Turbo, so you can use similar token quotas for both.

Use `TOKEN_QUOTA_DALL_E` to set the default quota for image generation. Otherwise it works the same as token quotas for other models.

```
# ~50 standard DALL-E images per refresh period, or US$2.00
TOKEN_QUOTA_DALL_E=200000
```

Refer to [https://openai.com/pricing](https://openai.com/pricing) for the latest pricing information. As of this writing, the cheapest DALL-E 3 image costs $0.04 per generation, which works out to 4000 tokens. Higher resolution and quality settings can cost up to $0.12 per image, or 12000 tokens. 

## Rate limiting
The old `MODEL_RATE_LIMIT` setting has been split into `TEXT_MODEL_RATE_LIMIT` and `IMAGE_MODEL_RATE_LIMIT`. Whatever value you previously set for `MODEL_RATE_LIMIT` will be used for text models.

If you don't specify a `IMAGE_MODEL_RATE_LIMIT`, it defaults to half of the `TEXT_MODEL_RATE_LIMIT`, to a minimum of 1 image per minute.

```
# 4 text generations per minute, 2 images per minute
TEXT_MODEL_RATE_LIMIT=4
IMAGE_MODEL_RATE_LIMIT=2
```

If a prompt is filtered by OpenAI's content filter, it won't count towards the rate limit.

## Hiding recent images
By default, the proxy shows the last 12 recently generated images by users. You can hide this section by setting `SHOW_RECENT_IMAGES` to `false`.
