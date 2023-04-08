import { Express } from "express-serve-static-core";
import { Key } from "../keys";

declare global {
  namespace Express {
    interface Request {
      key?: Key;
    }
  }
}
