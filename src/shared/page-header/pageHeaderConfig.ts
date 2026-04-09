import type { PageHeaderInfo } from "./types";

export const pageHeaderConfig: Record<string, PageHeaderInfo> = {
  "/ocr": {
    title: "発注書OCR",
    description:
      "発注書（PDF/画像）をアップロードすると、AIが内容を自動で読み取ります。",
  },
};

export const getPageHeaderByPath = (
  path: string
): PageHeaderInfo | undefined => {
  return pageHeaderConfig[path];
};
