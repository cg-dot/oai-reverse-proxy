import { Express } from "express-serve-static-core";
import { AIService, Key } from "../shared/key-management/index";
import { User } from "../shared/users/user-store";

declare global {
  namespace Express {
    interface Request {
      key?: Key;
      /** Denotes the format of the user's submitted request. */
      inboundApi: AIService | "kobold";
      /** Denotes the format of the request being proxied to the API. */
      outboundApi: AIService;
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
