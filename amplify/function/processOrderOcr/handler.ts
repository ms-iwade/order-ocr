import type { Schema } from "../../data/resource";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/processOrderOcr";
import { writePartialAndMergeIfReady } from "../shared/mergeResults";

const S3_REGION = "ap-northeast-1";
const BEDROCK_REGION = "us-east-1";
const MODEL_ID = "us.anthropic.claude-opus-4-6-v1";

const s3 = new S3Client({ region: S3_REGION });
const bedrock = new BedrockRuntimeClient({ region: BEDROCK_REGION });

// Amplify Data クライアント設定
const { resourceConfig, libraryOptions } =
  await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);
const client = generateClient<Schema>();

const OCR_PROMPT = `あなたは発注書（注文書）の表形式データを正確に読み取る高性能なロボットです。
この発注書（注文書）の表（テーブル）部分を読み取り、以下のJSON形式で出力してください。
印刷文字と手書き文字のどちらも読み取り対象です。表全体が手書きで構成されている場合でも、表の行と列の対応を保ちながら各行の値を抽出してください。

以下の手順を必ず上から順番に実行してください。

手順1: まずページごとに表を特定し、どの列が itemCode、quantity、deliveryDate に対応するかを判断してください。
- 「発注NO」と「コード」など複数の番号列がある場合、itemCode には「コード」列だけを使ってください。
- 「発注NO」など他の番号列は使わないでください。
- ただし「JANCD」または「JANコード」の列がある場合は、その値を itemCode として最優先で使ってください。
- 表のセル内にある値は、印刷文字でも手書き文字でも採用してください。
- 表全体が手書きでも、列見出しと各行の位置関係から itemCode、quantity、deliveryDate を対応づけてください。
- 備考欄や欄外メモの自由記述は、明らかに表のセル値ではない場合は lineItems に含めないでください。

手順2: 各ページの各商品行について、まず itemCode を確定してください。
- itemCode は必ず文字列のまま出力し、数値に変換しないでください。
- itemCode は左から右へ1文字ずつ確認し、見えている文字をその順番のまま転記してください。
- 途中の 0 を含むすべての文字を省略しないでください。
- 行ごとに桁数や文字数が異なる可能性があるため、他の行や一般的な品番長に合わせて 0 を補ったり削ったりしないでください。
- 先頭や末尾だけでなく途中にある 0 も原本どおりに保持してください。
- たとえば「10203」と見える場合に「123」と短縮してはいけません。
- たとえば原本が「100103」なら、0 の個数と位置をそのまま保持して「100103」と出力してください。
- 「10013」のように途中の 0 を落としてはいけません。
- itemCode をひとつの数値として概算せず、セル内の全文字列として扱ってください。
- 連続する数字や英字記号があれば、それぞれを独立した文字として丁寧に確認してください。
- itemCode の一部が不鮮明な場合でも、他の行や桁数パターンから推測で補完しないでください。
- 明確に読めないときだけ null にしてください。
- itemCode を出力する前に、原本セルを見直して 0 の個数と位置が一致しているか必ず再確認してください。

手順3: 次に quantity を確定してください。
- quantity は発注数に相当する列の値を使ってください。
- 印刷文字でも手書き文字でも構いません。
- quantity は数値型で出力してください。
- 明確に読めないときだけ null にしてください。

手順4: 次に deliveryDate を確定してください。
- まず、その行のテーブル内の納期列の値を確認してください。
- 印刷文字でも手書き文字でも構いません。
- 手書きの修正値が同じセル内で元の印刷値を上書きしていると判断できる場合は、最新の手書き値を採用してください。
- テーブルに納期列が見当たらない場合、または該当行の納期セルが空の場合だけ、PDF全体を見て、その注文全体に対する共通納期として明記された日付を探してください。
- 共通納期として採用してよいのは、「納入日」「納期」「出荷日」などの見出しの近くにある日付、または「○月○日にご用意いたします」「○/○納入予定」「○/○頃納品」など、納入日や出荷予定日だと明確に判断できる記載の日付です。
- 発注日、注文日、作成日、受付日、FAX日、回答期限、請求日など、単なる帳票情報や別用途の日付は納期として採用しないでください。
- PDF全体に対する共通納期を採用した場合は、その納期が適用される各行の deliveryDate に同じ日付を入れてください。
- テーブルにもPDF全体にも納期として使える日付が見つからない場合は、deliveryDate を null にしてください。

手順5: 最後にページごと・行ごとの対応関係を見直し、thinking に判断根拠を残してください。
- thinking には、itemCode をどの列から取得したか、JANCD 列があればそれを優先した理由、itemCode を1文字ずつどう確認したか、特に 0 を省略していないか、quantity をどの列から取得したか、deliveryDate をテーブルのどの列から取得したか、またはテーブルに納期列がないか空だったため PDF全体のどの記載から共通納期として採用したか、印刷文字と手書き文字のどちらを主に採用したかを記載してください。
- 読み取れない項目は null にしてください。
- PDFが複数ページある場合は、ページごとに pages の配列要素を分けて出力してください。

{
  "thinking": "読み取りの思考プロセス（品番・数量・納期の取得元、納期列を使ったかPDF全体の共通記載を使ったか、印刷文字と手書き文字のどちらを採用したかなどを記載）",
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
    throw new Error("OCRJOB_TABLE_NAME environment variable is not set");
  }

  let partialResult: unknown;

  try {
    // S3からPDFを取得
    const s3BucketName = process.env.S3_BUCKET_NAME;
    if (!s3BucketName) {
      throw new Error("S3_BUCKET_NAME environment variable is not set");
    }

    const s3Response = await s3.send(
      new GetObjectCommand({
        Bucket: s3BucketName,
        Key: s3Key,
      })
    );

    const pdfBytes = await s3Response.Body!.transformToByteArray();
    const pdfBase64 = Buffer.from(pdfBytes).toString("base64");

    // Bedrock Claude にPDFを送信してOCR処理（表全体）
    const bedrockResponse = await bedrock.send(
      new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 8192,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: pdfBase64,
                  },
                },
                {
                  type: "text",
                  text: OCR_PROMPT,
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

    // JSON部分を抽出（Claudeがコードブロックで返す場合に対応）
    const jsonMatch = ocrResultText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("OCR結果からJSONを抽出できませんでした");
    }

    partialResult = JSON.parse(jsonMatch[0]);
  } catch (error) {
    console.error("テーブルOCR処理エラー:", error);
    partialResult = {
      error: true,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }

  // 部分結果を書き込み、カウンタが2ならマージ
  try {
    await writePartialAndMergeIfReady({
      jobId,
      partialField: "tableResult",
      partialResult,
      tableName: ocrJobTableName,
      amplifyClient: client,
    });
  } catch (mergeError) {
    console.error("マージ処理エラー:", mergeError);
    await client.models.OcrJob.update({
      id: jobId,
      status: "FAILED",
      errorMessage:
        mergeError instanceof Error
          ? mergeError.message
          : "Unknown merge error",
    });
  }
};
