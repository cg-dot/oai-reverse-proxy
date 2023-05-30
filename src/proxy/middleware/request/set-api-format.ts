import { Request, RequestHandler } from "express";
import { AIService } from "../../../key-management";

export const setApiFormat = (api: {
  in: Request["inboundApi"];
  out: AIService;
}): RequestHandler => {
  return (req, _res, next) => {
    req.inboundApi = api.in;
    req.outboundApi = api.out;
    next();
  };
};
