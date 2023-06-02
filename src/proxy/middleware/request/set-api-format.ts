import { Request } from "express";
import { AIService } from "../../../key-management";
import { RequestPreprocessor } from ".";

export const setApiFormat = (api: {
  inApi: Request["inboundApi"];
  outApi: AIService;
}): RequestPreprocessor => {
  return (req) => {
    req.inboundApi = api.inApi;
    req.outboundApi = api.outApi;
  };
};
