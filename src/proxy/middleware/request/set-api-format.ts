import { Request } from "express";
import { APIFormat, LLMService } from "../../../shared/key-management";
import { RequestPreprocessor } from ".";

export const setApiFormat = (api: {
  inApi: Request["inboundApi"];
  outApi: APIFormat;
  service: LLMService,
}): RequestPreprocessor => {
  return function configureRequestApiFormat (req) {
    req.inboundApi = api.inApi;
    req.outboundApi = api.outApi;
    req.service = api.service;
  };
};
