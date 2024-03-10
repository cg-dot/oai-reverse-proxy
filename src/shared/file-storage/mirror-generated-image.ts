import axios from "axios";
import express from "express";
import { promises as fs } from "fs";
import path from "path";
import { v4 } from "uuid";
import { USER_ASSETS_DIR } from "../../config";
import { addToImageHistory } from "./image-history";
import { libSharp } from "./index";

export type OpenAIImageGenerationResult = {
  created: number;
  data: {
    revised_prompt?: string;
    url: string;
    b64_json: string;
  }[];
};

async function downloadImage(url: string) {
  const { data } = await axios.get(url, { responseType: "arraybuffer" });
  const buffer = Buffer.from(data, "binary");
  const newFilename = `${v4()}.png`;

  const filepath = path.join(USER_ASSETS_DIR, newFilename);
  await fs.writeFile(filepath, buffer);
  return filepath;
}

async function saveB64Image(b64: string) {
  const buffer = Buffer.from(b64, "base64");
  const newFilename = `${v4()}.png`;

  const filepath = path.join(USER_ASSETS_DIR, newFilename);
  await fs.writeFile(filepath, buffer);
  return filepath;
}

async function createThumbnail(filepath: string) {
  const thumbnailPath = filepath.replace(/(\.[\wd_-]+)$/i, "_t.jpg");

  await libSharp(filepath)
    .resize(150, 150, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .toFormat("jpeg")
    .toFile(thumbnailPath);

  return thumbnailPath;
}

/**
 * Downloads generated images and mirrors them to the user_content directory.
 * Mutates the result object.
 */
export async function mirrorGeneratedImage(
  req: express.Request,
  prompt: string,
  result: OpenAIImageGenerationResult
): Promise<OpenAIImageGenerationResult> {
  const host = req.protocol + "://" + req.get("host");
  for (const item of result.data) {
    let mirror: string;
    if (item.b64_json) {
      mirror = await saveB64Image(item.b64_json);
    } else {
      mirror = await downloadImage(item.url);
    }
    item.url = `${host}/user_content/${path.basename(mirror)}`;
    await createThumbnail(mirror);
    addToImageHistory({
      url: item.url,
      prompt,
      inputPrompt: req.body.prompt,
      token: req.user?.token});
  }
  return result;
}
