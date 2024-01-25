import { AzureOpenAIKey, keyPool } from "../../../../shared/key-management";
import { RequestPreprocessor } from "../index";

export const addAzureKey: RequestPreprocessor = (req) => {
  const apisValid = req.inboundApi === "openai" && req.outboundApi === "openai";
  const serviceValid = req.service === "azure";
  if (!apisValid || !serviceValid) {
    throw new Error("addAzureKey called on invalid request");
  }

  if (!req.body?.model) {
    throw new Error("You must specify a model with your request.");
  }

  const model = req.body.model.startsWith("azure-")
    ? req.body.model
    : `azure-${req.body.model}`;

  req.key = keyPool.get(model);
  req.body.model = model;
  
  // Handles the sole Azure API deviation from the OpenAI spec (that I know of)
  const notNullOrUndefined = (x: any) => x !== null && x !== undefined;
  if ([req.body.logprobs, req.body.top_logprobs].some(notNullOrUndefined)) {
    // OpenAI wants logprobs: true/false and top_logprobs: number
    // Azure seems to just want to combine them into logprobs: number
    // if (typeof req.body.logprobs === "boolean") {
    //   req.body.logprobs = req.body.top_logprobs || undefined;
    //   delete req.body.top_logprobs
    // }
    
    // Temporarily just disabling logprobs for Azure because their model support
    // is random: `This model does not support the 'logprobs' parameter.`
    delete req.body.logprobs;
    delete req.body.top_logprobs;
  }

  req.log.info(
    { key: req.key.hash, model },
    "Assigned Azure OpenAI key to request"
  );

  const cred = req.key as AzureOpenAIKey;
  const { resourceName, deploymentId, apiKey } = getCredentialsFromKey(cred);

  req.signedRequest = {
    method: "POST",
    protocol: "https:",
    hostname: `${resourceName}.openai.azure.com`,
    path: `/openai/deployments/${deploymentId}/chat/completions?api-version=2023-09-01-preview`,
    headers: {
      ["host"]: `${resourceName}.openai.azure.com`,
      ["content-type"]: "application/json",
      ["api-key"]: apiKey,
    },
    body: JSON.stringify(req.body),
  };
};

function getCredentialsFromKey(key: AzureOpenAIKey) {
  const [resourceName, deploymentId, apiKey] = key.key.split(":");
  if (!resourceName || !deploymentId || !apiKey) {
    throw new Error("Assigned Azure OpenAI key is not in the correct format.");
  }
  return { resourceName, deploymentId, apiKey };
}
