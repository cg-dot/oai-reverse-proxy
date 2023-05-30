import { Express } from "express-serve-static-core";
import { AIService, Key } from "../key-management/index";
import { User } from "../proxy/auth/user-store";

declare global {
  namespace Express {
    interface Request {
      key?: Key;
      /** Denotes the format of the user's submitted request. */
      inboundApi: AIService | "kobold";
      /** Denotes the format of the request being proxied to the API. */
      outboundApi: AIService;
      user?: User;
      isStreaming?: boolean;
      startTime: number;
      retryCount: number;
      queueOutTime?: number;
      onAborted?: () => void;
      proceed: () => void;
      heartbeatInterval?: NodeJS.Timeout;
    }
  }
}
