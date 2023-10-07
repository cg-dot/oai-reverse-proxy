import type { HttpRequest } from "@smithy/types";
import { Express } from "express-serve-static-core";
import { APIFormat, Key, LLMService } from "../shared/key-management";
import { User } from "../shared/users/schema";

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
      promptTokens?: number;
      outputTokens?: number;
      // TODO: remove later
      debug: Record<string, any>;
      signedRequest: HttpRequest;
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
