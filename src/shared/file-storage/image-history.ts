
type ImageHistory = {
  url: string;
  prompt: string;
}

const IMAGE_HISTORY_SIZE = 30;
const imageHistory = new Array<ImageHistory>(IMAGE_HISTORY_SIZE);
let imageHistoryIndex = 0;

export function getImageHistory() {
  return imageHistory.filter((url) => url);
}

export function addToImageHistory(image: ImageHistory) {
  imageHistory[imageHistoryIndex] = image;
  imageHistoryIndex = (imageHistoryIndex + 1) % IMAGE_HISTORY_SIZE;
}

export function getLastNImages(n: number) {
  const result: ImageHistory[] = [];
  let currentIndex = (imageHistoryIndex - 1 + IMAGE_HISTORY_SIZE) % IMAGE_HISTORY_SIZE;

  for (let i = 0; i < n; i++) {
    // Check if the current index is valid (not undefined).
    if (imageHistory[currentIndex]) {
      result.unshift(imageHistory[currentIndex]);
    }

    // Move to the previous item, wrapping around if necessary.
    currentIndex = (currentIndex - 1 + IMAGE_HISTORY_SIZE) % IMAGE_HISTORY_SIZE;
  }

  return result;
}
