import { Express } from "express-serve-static-core";
import { Key } from "../key-management/key-pool";

declare global {
  namespace Express {
    interface Request {
      key?: Key;
    }
  }
}
