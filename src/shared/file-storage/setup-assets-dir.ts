import { promises as fs } from "fs";
import { logger } from "../../logger";
import { USER_ASSETS_DIR } from "../../config";

const log = logger.child({ module: "file-storage" });

export async function setupAssetsDir() {
  try {
    log.info({ dir: USER_ASSETS_DIR }, "Setting up user assets directory");
    await fs.mkdir(USER_ASSETS_DIR, { recursive: true });
    const stats = await fs.stat(USER_ASSETS_DIR);
    const mode = stats.mode | 0o666;
    if (stats.mode !== mode) {
      await fs.chmod(USER_ASSETS_DIR, mode);
    }
  } catch (e) {
    log.error(e);
    throw new Error("Could not create user assets directory for DALL-E image generation. You may need to update your Dockerfile to `chown` the working directory to user 1000. See the proxy docs for more information.");
  }
}
