import { Express } from "express-serve-static-core";
import { Key } from "../key-management/key-pool";

declare global {
  namespace Express {
    interface Request {
      key?: Key;
      api: "kobold" | "openai" | "anthropic";
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
