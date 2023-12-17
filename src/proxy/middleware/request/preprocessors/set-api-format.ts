import { Request } from "express";
import { APIFormat } from "../../../../shared/key-management";
import { LLMService } from "../../../../shared/models";
import { RequestPreprocessor } from "../index";

export const setApiFormat = (api: {
  inApi: Request["inboundApi"];
  outApi: APIFormat;
  service: LLMService;
}): RequestPreprocessor => {
  return function configureRequestApiFormat(req) {
    req.inboundApi = api.inApi;
    req.outboundApi = api.outApi;
    req.service = api.service;
  };
};
