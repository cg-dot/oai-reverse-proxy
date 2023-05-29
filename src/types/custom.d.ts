import { Express } from "express-serve-static-core";
import { Key } from "../key-management/index";
import { User } from "../proxy/auth/user-store";

declare global {
  namespace Express {
    interface Request {
      key?: Key;
      /**
       * Denotes the _inbound_ API format. This is used to determine how the
       * user has submitted their request; the proxy will then translate the
       * paramaters to the target API format, which is on `key.service`.
       */
      api: "kobold" | "openai" | "anthropic";
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
