import express from "express";
import crypto from "crypto";
import { keyPool } from "../../../../shared/key-management";
import { RequestPreprocessor } from "../index";
import { refreshQuota } from "../../../../shared/users/user-store";
import {
  AnthropicV1MessagesSchema,
} from "../../../../shared/api-schemas";

const GCP_HOST =
  process.env.GCP_HOST || "%REGION%-aiplatform.googleapis.com";

export const signGcpRequest: RequestPreprocessor = async (req) => {
  const serviceValid = req.service === "gcp";
  if (!serviceValid) {
    throw new Error("addVertexAIKey called on invalid request");
  }

  if (!req.body?.model) {
    throw new Error("You must specify a model with your request.");
  }

  const { model, stream } = req.body;
  req.key = keyPool.get(model, "gcp");

  req.log.info(
    { key: req.key.hash, model },
    "Assigned GCP key to request"
  );

  req.isStreaming = stream === true || stream === "true";

  // TODO: This should happen in transform-outbound-payload.ts
  // TODO: Support tools
  let strippedParams: Record<string, unknown>;
  strippedParams = AnthropicV1MessagesSchema.pick({
    messages: true,
    system: true,
    max_tokens: true,
    stop_sequences: true,
    temperature: true,
    top_k: true,
    top_p: true,
    stream: true,
  })
    .strip()
    .parse(req.body);
  strippedParams.anthropic_version = "vertex-2023-10-16";

  const credential = getCredentialParts(req);
  const signedJWT = await createSignedJWT(credential.clientEmail, credential.privateKey)
  const [accessToken, jwtError] = await exchangeJwtForAccessToken(signedJWT)
  if (accessToken === null) {
    req.log.warn(
      { key: req.key.hash, jwtError },
      "Unable to get the access token"
    );
    throw new Error("The access token is invalid.");
  }

  const host = GCP_HOST.replace("%REGION%", credential.region);
  // GCP doesn't use the anthropic-version header, but we set it to ensure the
  // stream adapter selects the correct transformer.
  req.headers["anthropic-version"] = "2023-06-01";

  req.signedRequest = {
    method: "POST",
    protocol: "https:",
    hostname: host,
    path: `/v1/projects/${credential.projectId}/locations/${credential.region}/publishers/anthropic/models/${model}:streamRawPredict`,
    headers: {
      ["host"]: host,
      ["content-type"]: "application/json",
      ["authorization"]: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(strippedParams),
  };
};

async function createSignedJWT(email: string, pkey: string): Promise<string> {
  let cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    str2ab(atob(pkey)),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: { name: "SHA-256" },
    },
    false,
    ["sign"]
  );

  const authUrl = "https://www.googleapis.com/oauth2/v4/token";
  const issued = Math.floor(Date.now() / 1000);
  const expires = issued + 600;

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const payload = {
    iss: email,
    aud: authUrl,
    iat: issued,
    exp: expires,
    scope: "https://www.googleapis.com/auth/cloud-platform",
  };

  const encodedHeader = urlSafeBase64Encode(JSON.stringify(header));
  const encodedPayload = urlSafeBase64Encode(JSON.stringify(payload));

  const unsignedToken = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    str2ab(unsignedToken)
  );

  const encodedSignature = urlSafeBase64Encode(signature);
  return `${unsignedToken}.${encodedSignature}`;
}

async function exchangeJwtForAccessToken(signed_jwt: string): Promise<[string | null, string]> {
  const auth_url = "https://www.googleapis.com/oauth2/v4/token";
  const params = {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: signed_jwt,
  };

  const r = await fetch(auth_url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join("&"),
  }).then((res) => res.json());

  if (r.access_token) {
    return [r.access_token, ""];
  }

  return [null, JSON.stringify(r)];
}

function str2ab(str: string): ArrayBuffer {
  const buffer = new ArrayBuffer(str.length);
  const bufferView = new Uint8Array(buffer);
  for (let i = 0; i < str.length; i++) {
    bufferView[i] = str.charCodeAt(i);
  }
  return buffer;
}

function urlSafeBase64Encode(data: string | ArrayBuffer): string {
  let base64: string;
  if (typeof data === "string") {
    base64 = btoa(encodeURIComponent(data).replace(/%([0-9A-F]{2})/g, (match, p1) => String.fromCharCode(parseInt("0x" + p1, 16))));
  } else {
    base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
  }
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Credential = {
  projectId: string;
  clientEmail: string;
  region: string;
  privateKey: string;
};

function getCredentialParts(req: express.Request): Credential {
  const [projectId, clientEmail, region, rawPrivateKey] = req.key!.key.split(":");
  if (!projectId || !clientEmail || !region || !rawPrivateKey) {
    req.log.error(
      { key: req.key!.hash },
      "GCP_CREDENTIALS isn't correctly formatted; refer to the docs"
    );
    throw new Error("The key assigned to this request is invalid.");
  }

  const privateKey = rawPrivateKey
    .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\r|\n|\\n/g, '')
    .trim();

  return { projectId, clientEmail, region, privateKey };
}