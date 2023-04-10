import { Express } from "express-serve-static-core";
import { Key } from "../keys/key-pool";

declare global {
  namespace Express {
    interface Request {
      key?: Key;
    }
  }
}
