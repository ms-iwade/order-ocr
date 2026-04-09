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

const HANDWRITING_PROMPT = `この発注書（注文書）の画像を注意深く観察し、手書きで追記されたメモ・注釈のみを読み取ってください。
あなたの役割は手書き文字の読み取りに特化しています。印刷された活字は無視し、手書きの文字だけに集中してください。

まず、読み取りの思考プロセスをthinkingフィールドに記録してください。特に以下の点を明記してください：
- 画像のどの位置に手書き文字を発見したか
- 各手書きメモの内容と、判読に至った過程（文字の形状、筆跡の特徴など）
- 日付が含まれている場合は、その数字をどう解釈したか

【重要】手書き文字の読み取り方針：
- 備考欄・摘要欄・余白・行間など、あらゆる箇所の手書き文字を探してください
- 手書きメモは発注書の印刷後に追記された最新情報です
- 「○月○日」「○/○」「○日」など、日付を示す手書きの記載を丁寧に探してください
- 「欠品のため○/○にご用意」「○/○入荷予定」「○/○出荷」「○/○ご依頼」「バックオーダー○/○」など、日付を含む文言に注意してください
- 判読困難な場合でも、日付らしき数字（例: 5/8、2/13など）が読み取れれば採用してください
- 数量の手書き修正がある場合も読み取ってください

手書きメモがどの商品行に対応するかを特定するために、その行の近くに印刷されている品番を参照してitemCodeに記載してください。
品番は文字列として、先頭や末尾のゼロを含め原本のまま出力してください。

出力形式（JSONのみを出力してください）：

{
  "thinking": "手書き文字の読み取りプロセス（発見位置、筆跡の判読過程、日付の解釈など）",
  "pages": [
    {
      "page": 1,
      "handwrittenItems": [
        {
          "itemCode": "対応する商品行の品番（近くに印刷されたコードを参照）",
          "deliveryDate": "手書きの日付（YYYY-MM-DD形式、日付がなければnull）",
          "note": "手書きメモの全文書き起こし"
        }
      ]
    }
  ],
  "confidence": "読み取り信頼度（high/medium/low）"
}

手書きメモがない行は出力しないでください。
手書きの文字がまったくない場合は、handwrittenItemsを空配列にしてください。
PDFが複数ページある場合は、ページごとにpagesの配列要素を分けて出力してください。
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

    partialResult = JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error('手書きOCR処理エラー:', error);
    partialResult = {
      error: true,
      message: error instanceof Error ? error.message : 'Unknown error',
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
