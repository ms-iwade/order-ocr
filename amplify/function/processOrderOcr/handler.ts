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

const OCR_PROMPT = `この発注書（注文書）の表（テーブル）部分を読み取り、以下のJSON形式で出力してください。
印刷文字と手書き文字のどちらも読み取り対象です。特に、表全体が手書きで構成されている場合でも、表の行と列の対応を保ちながら各行の値を抽出してください。

まず、読み取りの思考プロセスをthinkingフィールドに記録してください。特に以下の点について判断根拠を明記してください：
- 品番（itemCode）をどの列から取得したか（JANCD列があればそちらを優先した理由など）
- 品番を1文字ずつどう確認したか。特に 0 を含む箇所を省略せず、原本どおりに保持できているか
- 数量（quantity）をテーブルのどの列から取得したか
- 納期（deliveryDate）をテーブルのどの列から取得したか
- 印刷文字と手書き文字のどちらを主に採用したか

読み取りルール：
- 読み取れない項目はnullにしてください。数量は数値型にしてください。
- テーブルに「発注NO」と「コード」など複数の列がある場合、itemCodeには「コード」列の値のみを使用してください。「発注NO」や他の番号列は無視してください。
- ただし、テーブルに「JANCD」や「JANコード」の列がある場合は、その値を品番（itemCode）として優先的に使用してください。
- 品番（コード）は必ず文字列として出力してください。数値に変換しないでください。
- 品番は左から右へ1文字ずつ確認し、見えている文字をその順番のまま転記してください。途中の 0 を含むすべての文字を省略しないでください。
- 品番の桁数や文字数は行ごとに異なる可能性があります。他の行や一般的な品番長に合わせて、0 を補ったり削ったりしないでください。
- 先頭・末尾だけでなく、途中にある 0 も原本どおりに保持してください。たとえば「10203」と見える場合に「123」と短縮しないでください。
- たとえば原本が「100103」なら、0 の個数と位置をそのまま保持して「100103」と出力してください。「10013」のように途中の 0 を落としてはいけません。
- 品番をひとつの数値として概算せず、セル内の全文字列として扱ってください。連続する数字や英字記号があれば、それぞれを独立した文字として丁寧に確認してください。
- 品番を出力する前に、原本セルを見直して 0 の個数と位置が一致しているか必ず再確認してください。
- 品番の一部が不鮮明な場合でも、他の行や桁数パターンから推測で補完しないでください。明確に読めないときだけnullにしてください。
- 表のセル内にある値は、印刷文字でも手書き文字でも採用してください。
- 表全体が手書きの場合でも、列見出しと各行の位置関係から itemCode、quantity、deliveryDate を対応づけてください。
- 納期（deliveryDate）はテーブルの納期列の値を使用してください。印刷文字でも手書き文字でも構いません。値がない場合はnullにしてください。
- 数量（quantity）は発注数に相当する列の値を使用してください。印刷文字でも手書き文字でも構いません。
- 備考欄や欄外メモの自由記述は、明らかに表のセル値ではない場合は lineItems に含めないでください。
- 手書きの修正値が同じセル内で元の印刷値を上書きしていると判断できる場合は、最新の手書き値を採用してください。
- PDFが複数ページある場合は、ページごとにpagesの配列要素を分けて出力してください。

{
  "thinking": "読み取りの思考プロセス（品番・数量・納期の取得元、印刷文字と手書き文字のどちらを採用したかなどを記載）",
  "pages": [
    {
      "page": 1,
      "lineItems": [
        {
          "itemCode": "品番・コード列の値（JANCDがあればそちらを優先。たとえば100103は10013にせず、途中の0の個数と位置を保ったまま1文字も省略せず出力）",
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
 * S3からPDFを取得 → Bedrock Claudeで表全体を読み取り → 部分結果を書き込み → マージ
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

    // Bedrock Claude にPDFを送信してOCR処理（表全体）
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
