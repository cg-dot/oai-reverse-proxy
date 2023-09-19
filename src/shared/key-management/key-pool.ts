import type * as http from "http";
import schedule from "node-schedule";
import { config } from "../../config";
import { logger } from "../../logger";
import { Key, Model, KeyProvider, APIFormat } from "./index";
import { AnthropicKeyProvider, AnthropicKeyUpdate } from "./anthropic/provider";
import { OpenAIKeyProvider, OpenAIKeyUpdate } from "./openai/provider";
import { GooglePalmKeyProvider } from "./palm/provider";

type AllowedPartial = OpenAIKeyUpdate | AnthropicKeyUpdate;

export class KeyPool {
  private keyProviders: KeyProvider[] = [];
  private recheckJobs: Partial<Record<APIFormat, schedule.Job | null>> = {
    openai: null,
  };

  constructor() {
    this.keyProviders.push(new OpenAIKeyProvider());
    this.keyProviders.push(new AnthropicKeyProvider());
    this.keyProviders.push(new GooglePalmKeyProvider());
  }

  public init() {
    this.keyProviders.forEach((provider) => provider.init());
    const availableKeys = this.available("all");
    if (availableKeys === 0) {
      throw new Error(
        "No keys loaded. Ensure OPENAI_KEY, ANTHROPIC_KEY, or GOOGLE_PALM_KEY are set."
      );
    }
    this.scheduleMonthlyRecheck();
  }

  public get(model: Model): Key {
    const service = this.getService(model);
    return this.getKeyProvider(service).get(model);
  }

  public list(): Omit<Key, "key">[] {
    return this.keyProviders.flatMap((provider) => provider.list());
  }

  public disable(key: Key, reason: "quota" | "revoked"): void {
    const service = this.getKeyProvider(key.service);
    service.disable(key);
    if (service instanceof OpenAIKeyProvider) {
      service.update(key.hash, {
        isRevoked: reason === "revoked",
        isOverQuota: reason === "quota",
      });
    }
  }

  public update(key: Key, props: AllowedPartial): void {
    const service = this.getKeyProvider(key.service);
    service.update(key.hash, props);
  }

  public available(service: APIFormat | "all" = "all"): number {
    return this.keyProviders.reduce((sum, provider) => {
      const includeProvider = service === "all" || service === provider.service;
      return sum + (includeProvider ? provider.available() : 0);
    }, 0);
  }

  public anyUnchecked(): boolean {
    return this.keyProviders.some((provider) => provider.anyUnchecked());
  }

  public incrementUsage(key: Key, model: string, tokens: number): void {
    const provider = this.getKeyProvider(key.service);
    provider.incrementUsage(key.hash, model, tokens);
  }

  public getLockoutPeriod(model: Model): number {
    const service = this.getService(model);
    return this.getKeyProvider(service).getLockoutPeriod(model);
  }

  public markRateLimited(key: Key): void {
    const provider = this.getKeyProvider(key.service);
    provider.markRateLimited(key.hash);
  }

  public updateRateLimits(key: Key, headers: http.IncomingHttpHeaders): void {
    const provider = this.getKeyProvider(key.service);
    if (provider instanceof OpenAIKeyProvider) {
      provider.updateRateLimits(key.hash, headers);
    }
  }

  public recheck(service: APIFormat): void {
    if (!config.checkKeys) {
      logger.info("Skipping key recheck because key checking is disabled");
      return;
    }

    const provider = this.getKeyProvider(service);
    provider.recheck();
  }

  private getService(model: Model): APIFormat {
    if (model.startsWith("gpt")) {
      // https://platform.openai.com/docs/models/model-endpoint-compatibility
      return "openai";
    } else if (model.startsWith("claude-")) {
      // https://console.anthropic.com/docs/api/reference#parameters
      return "anthropic";
    } else if (model.includes("bison")) {
      // https://developers.generativeai.google.com/models/language
      return "google-palm";
    }
    throw new Error(`Unknown service for model '${model}'`);
  }

  private getKeyProvider(service: APIFormat): KeyProvider {
    // The "openai-text" service is a special case handled by OpenAIKeyProvider.
    if (service === "openai-text") {
      service = "openai";
    }

    return this.keyProviders.find((provider) => provider.service === service)!;
  }

  private scheduleMonthlyRecheck(): void {
    // On the first of the month, OpenAI resets the token quota for all keys.
    // This process takes a few hours, so we'll schedule multiple rechecks
    // throughout that day.
    const rule = "45 */6 1 * *";
    const job = schedule.scheduleJob(rule, () => {
      logger.info("Performing monthly recheck of OpenAI keys");
      this.recheck("openai");
    });
    logger.info(
      { rule, next: job.nextInvocation() },
      "Scheduled monthly recheck of OpenAI keys"
    );
    this.recheckJobs.openai = job;
  }
}
