const IMAGE_HISTORY_SIZE = 10000;
const imageHistory = new Array<ImageHistory>(IMAGE_HISTORY_SIZE);
let index = 0;

type ImageHistory = {
  url: string;
  prompt: string;
  inputPrompt: string;
  token?: string;
};

export function addToImageHistory(image: ImageHistory) {
  if (image.token?.length) {
    image.token = `...${image.token.slice(-5)}`;
  }
  imageHistory[index] = image;
  index = (index + 1) % IMAGE_HISTORY_SIZE;
}

export function getLastNImages(n: number = IMAGE_HISTORY_SIZE): ImageHistory[] {
  const result: ImageHistory[] = [];
  let currentIndex = (index - 1 + IMAGE_HISTORY_SIZE) % IMAGE_HISTORY_SIZE;

  for (let i = 0; i < n; i++) {
    if (imageHistory[currentIndex]) result.unshift(imageHistory[currentIndex]);
    currentIndex = (currentIndex - 1 + IMAGE_HISTORY_SIZE) % IMAGE_HISTORY_SIZE;
  }

  return result;
}
