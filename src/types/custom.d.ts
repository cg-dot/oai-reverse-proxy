import { Express } from "express-serve-static-core";
import { Key } from "../key-management/key-pool";
import { User } from "../proxy/auth/user-store";

declare global {
  namespace Express {
    interface Request {
      key?: Key;
      api: "kobold" | "openai" | "anthropic";
      user: User;
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
