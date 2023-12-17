// noinspection JSUnusedGlobalSymbols,ES6UnusedImports

import type { HttpRequest } from "@smithy/types";
import { Express } from "express-serve-static-core";
import { APIFormat, Key } from "./key-management";
import { User } from "./users/schema";
import { LLMService, ModelFamily } from "./models";

declare global {
  namespace Express {
    interface Request {
      key?: Key;
      service?: LLMService;
      /** Denotes the format of the user's submitted request. */
      inboundApi: APIFormat;
      /** Denotes the format of the request being proxied to the API. */
      outboundApi: APIFormat;
      /** If the request comes from a RisuAI.xyz user, this is their token. */
      risuToken?: string;
      user?: User;
      isStreaming?: boolean;
      startTime: number;
      retryCount: number;
      queueOutTime?: number;
      onAborted?: () => void;
      proceed: () => void;
      heartbeatInterval?: NodeJS.Timeout;
      monitorInterval?: NodeJS.Timeout;
      promptTokens?: number;
      outputTokens?: number;
      tokenizerInfo: Record<string, any>;
      signedRequest: HttpRequest;
      modelFamily?: ModelFamily;
    }
  }
}

declare module "express-session" {
  interface SessionData {
    adminToken?: string;
    userToken?: string;
    csrf?: string;
    flash?: { type: string; message: string };
  }
}
