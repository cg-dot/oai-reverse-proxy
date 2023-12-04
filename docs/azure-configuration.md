# Configuring the proxy for Azure

The proxy supports Azure OpenAI Service via the `/proxy/azure/openai` endpoint. The process of setting it up is slightly different from regular OpenAI.

- [Setting keys](#setting-keys)
- [Model assignment](#model-assignment)

## Setting keys

Use the `AZURE_CREDENTIALS` environment variable to set the Azure API keys.

Like other APIs, you can provide multiple keys separated by commas. Each Azure key, however, is a set of values including the Resource Name, Deployment ID, and API key. These are separated by a colon (`:`).

For example:
```
AZURE_CREDENTIALS=contoso-ml:gpt4-8k:0123456789abcdef0123456789abcdef,northwind-corp:testdeployment:0123456789abcdef0123456789abcdef
```

## Model assignment
Note that each Azure deployment is assigned a model when you create it in the Azure OpenAI Service portal. If you want to use a different model, you'll need to create a new deployment, and therefore a new key to be added to the AZURE_CREDENTIALS environment variable. Each credential only grants access to one model.

### Supported model IDs
Users can send normal OpenAI model IDs to the proxy to invoke the corresponding models. For the most part they work the same with Azure. GPT-3.5 Turbo has an ID of "gpt-35-turbo" because Azure doesn't allow periods in model names, but the proxy should automatically convert this to the correct ID.

As noted above, you can only use model IDs for which a deployment has been created and added to the proxy.

## On content filtering
Be aware that all Azure OpenAI Service deployments have content filtering enabled by default at a Medium level. Prompts or responses which are deemed to be inappropriate will be rejected by the API. This is a feature of the Azure OpenAI Service and not the proxy.

You can disable this from deployment's settings within Azure, but you would need to request an exemption from Microsoft for your organization first. See [this page](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/content-filters) for more information.
