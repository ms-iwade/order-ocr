import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import type { Schema } from "../../data/resource";

/** テーブルOCRの行アイテム */
interface TableLineItem {
  itemCode: string | null;
  quantity: number | null;
  deliveryDate: string | null;
}

/** テーブルOCR結果 */
interface TableResult {
  processingTimeMs?: number;
  pages: Array<{
    page: number;
    lineItems: TableLineItem[];
  }>;
  confidence: "high" | "medium" | "low";
  error?: boolean;
  message?: string;
}

/** 手書きOCRの行アイテム */
interface HandwrittenItem {
  itemCode: string | null;
  deliveryDate: string | null;
}

/** 手書きOCR結果 */
interface HandwritingResult {
  processingTimeMs?: number;
  pages: Array<{
    page: number;
    handwrittenItems: HandwrittenItem[];
  }>;
  confidence: "high" | "medium" | "low";
  error?: boolean;
  message?: string;
}

/** マージ済み行アイテム */
interface MergedLineItem {
  itemCode: string | null;
  quantity: number | null;
  deliveryDate: string | null;
  handwrittenDeliveryDate?: string | null;
  deliveryDateSource?: "printed" | "handwritten";
}

/** マージ済み結果 */
interface MergedResult {
  errorMessage?: string;
  tableProcessingTimeMs?: number;
  handwritingProcessingTimeMs?: number;
  pages: Array<{
    page: number;
    lineItems: MergedLineItem[];
  }>;
  confidence: "high" | "medium" | "low";
}

/**
 * テーブルOCR結果と手書きOCR結果をマージする
 * 手書きの日付はテーブルの日付より優先される
 */
export function mergeResults(
  tableResult: TableResult | null,
  handwritingResult: HandwritingResult | null
): MergedResult {
  // テーブル結果がない場合（エラー等）は空結果を返す
  if (!tableResult || tableResult.error) {
    return {
      errorMessage: tableResult?.message || "テーブルOCRが失敗しました",
      tableProcessingTimeMs: tableResult?.processingTimeMs,
      handwritingProcessingTimeMs: handwritingResult?.processingTimeMs,
      pages: [],
      confidence: "low",
    };
  }

  // 手書き結果をページ・品番でインデックス化
  const handwritingIndex = new Map<string, HandwrittenItem>();
  if (handwritingResult && !handwritingResult.error) {
    for (const page of handwritingResult.pages) {
      for (const item of page.handwrittenItems) {
        if (item.itemCode) {
          const key = `${page.page}:${item.itemCode}`;
          handwritingIndex.set(key, item);
        }
      }
    }
  }

  const mergedPages = tableResult.pages.map((page) => {
    const mergedLineItems: MergedLineItem[] = page.lineItems.map((item) => {
      const key = item.itemCode ? `${page.page}:${item.itemCode}` : "";
      const handwritten = key ? handwritingIndex.get(key) : undefined;

      if (handwritten) {
        return {
          itemCode: item.itemCode,
          quantity: item.quantity,
          deliveryDate: item.deliveryDate,
          handwrittenDeliveryDate: handwritten.deliveryDate,
          deliveryDateSource: "printed" as const,
        };
      }

      return {
        itemCode: item.itemCode,
        quantity: item.quantity,
        deliveryDate: item.deliveryDate,
        handwrittenDeliveryDate: null,
        deliveryDateSource: "printed" as const,
      };
    });

    return { page: page.page, lineItems: mergedLineItems };
  });

  // confidenceは両方の低い方を採用
  const confidenceLevels = { high: 3, medium: 2, low: 1 };
  const tableConf = confidenceLevels[tableResult.confidence] || 1;
  const hwConf =
    handwritingResult && !handwritingResult.error
      ? confidenceLevels[handwritingResult.confidence] || 1
      : 3; // 手書き結果がない場合はテーブルの信頼度をそのまま使う
  const minConf = Math.min(tableConf, hwConf);
  const confidence = minConf >= 3 ? "high" : minConf >= 2 ? "medium" : "low";

  return {
    errorMessage:
      handwritingResult && handwritingResult.error
        ? handwritingResult.message || "手書きOCRが失敗しました"
        : undefined,
    tableProcessingTimeMs: tableResult.processingTimeMs,
    handwritingProcessingTimeMs: handwritingResult?.processingTimeMs,
    pages: mergedPages,
    confidence,
  };
}

const dynamodb = new DynamoDBClient({ region: "ap-northeast-1" });

/**
 * 部分結果をDynamoDBにアトミックに書き込み、カウンタをインクリメント。
 * カウンタが2に達したらマージ処理を実行し、最終結果を書き込む。
 */
export async function writePartialAndMergeIfReady(params: {
  jobId: string;
  partialField: "tableResult" | "handwritingResult";
  partialResult: unknown;
  tableName: string;
  amplifyClient: ReturnType<typeof generateClient<Schema>>;
}): Promise<void> {
  const { jobId, partialField, partialResult, tableName, amplifyClient } =
    params;

  // アトミックに部分結果を書き込み＋カウンタインクリメント
  const updateResult = await dynamodb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { id: { S: jobId } },
      UpdateExpression: "SET #partialField = :partialResult ADD #counter :one",
      ExpressionAttributeNames: {
        "#partialField": partialField,
        "#counter": "subJobCount",
      },
      ExpressionAttributeValues: {
        ":partialResult": { S: JSON.stringify(partialResult) },
        ":one": { N: "1" },
      },
      ReturnValues: "ALL_NEW",
    })
  );

  const newCount = parseInt(updateResult.Attributes?.subJobCount?.N ?? "0");

  if (newCount === 2) {
    // 最後に終わったLambda → マージ処理を実行
    const tableResultStr = updateResult.Attributes?.tableResult?.S ?? null;
    const handwritingResultStr =
      updateResult.Attributes?.handwritingResult?.S ?? null;

    const tableResultParsed = tableResultStr
      ? JSON.parse(tableResultStr)
      : null;
    const handwritingResultParsed = handwritingResultStr
      ? JSON.parse(handwritingResultStr)
      : null;

    const merged = mergeResults(tableResultParsed, handwritingResultParsed);

    await amplifyClient.models.OcrJob.update({
      id: jobId,
      status: "COMPLETED",
      result: JSON.stringify(merged),
    });
  }
}
