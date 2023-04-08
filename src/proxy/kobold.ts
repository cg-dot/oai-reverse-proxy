import { Request, Response, NextFunction } from "express";

export const kobold = (req: Request, res: Response, next: NextFunction) => {
  // TODO: Implement kobold
  res.status(501).json({ error: "Not implemented" });
};
