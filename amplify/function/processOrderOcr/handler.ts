import type { Schema } from '../../data/resource';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/processOrderOcr';
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

const OCR_PROMPT = `この発注書（注文書）の表（テーブル）部分の印刷されたテキストのみを読み取り、以下のJSON形式で出力してください。
手書きの文字は別途処理しますので、このタスクでは無視してください。印刷された列の値のみを読み取ってください。

まず、読み取りの思考プロセスをthinkingフィールドに記録してください。特に以下の点について判断根拠を明記してください：
- 品番（itemCode）をどの列から取得したか（JANCD列があればそちらを優先した理由など）
- 納期（deliveryDate）をテーブルのどの列から取得したか

読み取りルール：
- 読み取れない項目はnullにしてください。数量は数値型にしてください。
- テーブルに「発注NO」と「コード」など複数の列がある場合、itemCodeには「コード」列の値のみを使用してください。「発注NO」や他の番号列は無視してください。
- ただし、テーブルに「JANCD」や「JANコード」の列がある場合は、その値を品番（itemCode）として優先的に使用してください。
- 品番（コード）は必ず文字列として出力してください。先頭や末尾のゼロを含め、原本に記載されている桁数を正確にそのまま保持してください。数値に変換しないでください。
- 納期（deliveryDate）はテーブルの納期列に印刷されている値を使用してください。値がない場合はnullにしてください。
- PDFが複数ページある場合は、ページごとにpagesの配列要素を分けて出力してください。

{
  "thinking": "読み取りの思考プロセス（品番の取得元、納期の判断根拠などを記載）",
  "pages": [
    {
      "page": 1,
      "lineItems": [
        {
          "itemCode": "品番・コード列の値（JANCDがあればそちらを優先、文字列のまま出力）",
          "quantity": 発注数,
          "deliveryDate": "納期（YYYY-MM-DD形式）"
        }
      ]
    }
  ],
  "confidence": "読み取り信頼度（high/medium/low）"
}

JSONのみを出力し、それ以外のテキストは含めないでください。`;

/**
 * 発注書OCR処理のLambdaハンドラー（非同期起動）
 * startOrderOcr から InvocationType: 'Event' で起動される
 * S3からPDFを取得 → Bedrock Claudeで印刷テーブルを読み取り → 部分結果を書き込み → マージ
 */
export const handler = async (event: {
  jobId: string;
  s3Key: string;
  fileName: string;
}) => {
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

    // Bedrock Claude にPDFを送信してOCR処理（印刷テーブルのみ）
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
                  text: OCR_PROMPT,
                },
              ],
            },
          ],
        }),
      })
    );

    const responseBody = JSON.parse(new TextDecoder().decode(bedrockResponse.body));
    const ocrResultText = responseBody.content[0].text;

    // JSON部分を抽出（Claudeがコードブロックで返す場合に対応）
    const jsonMatch = ocrResultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('OCR結果からJSONを抽出できませんでした');
    }

    partialResult = JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('テーブルOCR処理エラー:', error);
    partialResult = {
      error: true,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // 部分結果を書き込み、カウンタが2ならマージ
  try {
    await writePartialAndMergeIfReady({
      jobId,
      partialField: 'tableResult',
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
