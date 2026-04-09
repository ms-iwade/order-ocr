export interface OcrLineItem {
  itemCode: string | null;
  quantity: number | null;
  deliveryDate: string | null;
  handwrittenNote?: string | null;
  deliveryDateSource?: 'printed' | 'handwritten';
}

export interface OcrPage {
  page: number;
  lineItems: OcrLineItem[];
}

export interface OcrResult {
  thinking?: string;
  tableThinking?: string;
  handwritingThinking?: string;
  pages: OcrPage[];
  confidence: 'high' | 'medium' | 'low';
}

export interface OcrResponse {
  statusCode: number;
  fileName: string;
  s3Key: string;
  status: 'COMPLETED' | 'FAILED';
  result: string | null;
  errorMessage?: string;
}
