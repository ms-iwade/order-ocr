import type { Schema } from '../../data/resource';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/processHandwritingOcr';
import { writePartialAndMergeIfReady } from '../shared/mergeResults';

const S3_REGION = 'ap-northeast-1';
const BEDROCK_REGION = 'us-east-1';
const MODEL_ID = 'us.anthropic.claude-opus-4-6-v1';

const s3 = new S3Client({ region: S3_REGION });
const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

// Amplify Data クライアント設定
const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

const HANDWRITING_PROMPT = `あなたは発注書の備考欄にある手書き納期の読取担当です。
表の各行について、備考欄に手書きで書かれた日付だけを抽出してください。印刷文字、備考欄以外の手書き、数量修正、関係ないメモは無視してください。

読取手順：
1. どの行の備考欄に手書きがあるか特定する
2. その手書きから納期として使える日付だけを読む
3. 読めた日付をその行の結果として出力する

読取ルール：
- 備考欄の見出しは「備考」「摘要」「記事」「メモ」などの表記ゆれを含みます
- 「5/8」「2/13」「3月6日」など日付表記を優先して拾ってください
- 日付部分が読めるなら、その数字を最優先で採用してください
- 5/8 と読めるなら、3/6 や 2/26 など別の日付へ推測で置き換えないでください
- 手書きが枠線ぎりぎり、少しはみ出し、欄外寄りでも、その行の備考欄への追記と判断できるなら採用してください
- 明確に別の欄や完全な欄外メモと判断できる場合だけ除外してください
- 手書き全文を読めなくても、日付だけ読めれば採用してください
- thinking に書いた日付候補は、最終結果でも反映してください

itemCode のルール：
- 同じ行の品番を itemCode に入れてください
- 「JANCD」または「JANコード」の列がある場合は、その値を最優先で使ってください
- それらがない場合のみ「コード」列を使ってください
- 「発注NO」など他の番号列は使わないでください
- itemCode は文字列のまま出力してください

出力形式（JSONのみ、thinkingも日本語のみ）：

{
  "thinking": "日本語で簡潔に、どの行の備考欄からどの日付を読んだかを書く",
  "pages": [
    {
      "page": 1,
      "handwrittenItems": [
        {
          "itemCode": "対応する商品行の品番（JANCD/JANコードを最優先、なければコード列）",
          "deliveryDate": "手書きの日付（YYYY-MM-DD形式）"
        }
      ]
    }
  ],
  "confidence": "読み取り信頼度（high/medium/low）"
}

日付を読み取れた行だけを出力してください。
手書きの文字がまったくない場合は、handwrittenItemsを空配列にしてください。
PDFが複数ページある場合は、ページごとにpagesの配列要素を分けて出力してください。
英語は使わないでください。
JSONのみを出力し、それ以外のテキストは含めないでください。`;

/**
 * 手書きメモ専用OCR処理のLambdaハンドラー（非同期起動）
 * startOrderOcr から InvocationType: 'Event' で起動される
 * S3からPDFを取得 → Bedrock Claudeで手書き部分を読み取り → 部分結果を書き込み → マージ
 */
export const handler = async (event: {
  jobId: string;
  s3Key: string;
  fileName: string;
}) => {
  const startedAt = Date.now();
  const { jobId, s3Key } = event;
  const ocrJobTableName = process.env.OCRJOB_TABLE_NAME;

  if (!ocrJobTableName) {
    throw new Error('OCRJOB_TABLE_NAME environment variable is not set');
  }

  let partialResult: unknown;

  try {
    // S3からPDFを取得
    const s3BucketName = process.env.S3_BUCKET_NAME;
    if (!s3BucketName) {
      throw new Error('S3_BUCKET_NAME environment variable is not set');
    }

    const s3Response = await s3.send(
      new GetObjectCommand({
        Bucket: s3BucketName,
        Key: s3Key,
      })
    );

    const pdfBytes = await s3Response.Body!.transformToByteArray();
    const pdfBase64 = Buffer.from(pdfBytes).toString('base64');

    // Bedrock Claude に手書き専用プロンプトでPDFを送信
    const bedrockResponse = await bedrock.send(
      new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 8192,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: pdfBase64,
                  },
                },
                {
                  type: 'text',
                  text: HANDWRITING_PROMPT,
                },
              ],
            },
          ],
        }),
      })
    );

    const responseBody = JSON.parse(
      new TextDecoder().decode(bedrockResponse.body)
    );
    const ocrResultText = responseBody.content[0].text;

    // JSON部分を抽出
    const jsonMatch = ocrResultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('手書きOCR結果からJSONを抽出できませんでした');
    }

    partialResult = {
      ...JSON.parse(jsonMatch[0]),
      processingTimeMs: Date.now() - startedAt,
    };
  } catch (error) {
    console.error('手書きOCR処理エラー:', error);
    partialResult = {
      error: true,
      message: error instanceof Error ? error.message : 'Unknown error',
      processingTimeMs: Date.now() - startedAt,
    };
  }

  // 部分結果を書き込み、カウンタが2ならマージ
  try {
    await writePartialAndMergeIfReady({
      jobId,
      partialField: 'handwritingResult',
      partialResult,
      tableName: ocrJobTableName,
      amplifyClient: client,
    });
  } catch (mergeError) {
    console.error('マージ処理エラー:', mergeError);
    await client.models.OcrJob.update({
      id: jobId,
      status: 'FAILED',
      errorMessage:
        mergeError instanceof Error
          ? mergeError.message
          : 'Unknown merge error',
    });
  }
};
