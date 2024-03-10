import express, { Request, Response } from "express";
import { getLastNImages } from "../../shared/file-storage/image-history";
import { paginate } from "../../shared/utils";
import { ipLimiter } from "../../proxy/rate-limit";

const IMAGES_PER_PAGE = 24;

const metadataCacheTTL = 1000 * 60 * 3;
let metadataCache: string | null = null;
let metadataCacheValid = 0;

const handleImageHistoryPage = (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const allImages = getLastNImages();
  const { items, pageCount } = paginate(allImages, page, IMAGES_PER_PAGE);

  res.render("image_history", {
    images: items,
    pagination: {
      currentPage: page,
      totalPages: pageCount,
    },
  });
};

const handleMetadataRequest = (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "public, max-age=180");
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="image-metadata-${new Date().toISOString()}.json"`
  );
  if (new Date().getTime() - metadataCacheValid < metadataCacheTTL) {
    return res.status(200).send(metadataCache);
  }

  const images = getLastNImages().map(({ prompt, url }) => ({ url, prompt }));
  const metadata = {
    exportedAt: new Date().toISOString(),
    totalImages: images.length,
    images,
  };
  metadataCache = JSON.stringify(metadata, null, 2);
  metadataCacheValid = new Date().getTime();
  res.status(200).send(metadataCache);
};

export const browseImagesRouter = express.Router();
browseImagesRouter.get("/image-history", handleImageHistoryPage);
browseImagesRouter.get(
  "/image-history/metadata",
  ipLimiter,
  handleMetadataRequest
);
