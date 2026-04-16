import type { Schema } from "../../data/resource";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { Amplify } from "aws-amplify";
import { generateClient } from "aws-amplify/data";
import { getAmplifyDataClientConfig } from "@aws-amplify/backend/function/runtime";
import { env } from "$amplify/env/processHandwritingOcr";
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

const HANDWRITING_PROMPT = `あなたは発注書の備考欄と出荷日回答欄にある手書き納期の読取担当です。
表の各行について、表の罫線内にある備考欄または出荷日回答欄のセル内に手書きで書かれた日付だけを抽出してください。印刷文字、対象欄以外の手書き、数量修正、関係ないメモは無視してください。

以下の手順を必ず上から順番に実行してください。

手順1: まず対象となる列を特定してください。
- 備考欄の見出しは「備考」「摘要」「記事」「メモ」などの表記ゆれを含みます。
- 出荷日回答欄の見出しは「出荷日回答」「出荷日」「納期回答」などの表記ゆれを含みます。
- 表の罫線で区切られた商品行のうち、これらの対象列のセル内にある手書きだけを候補にしてください。
- 表の外側、ヘッダー、フッター、余白、欄外メモ、印影付近、ページ上部や下部にある日付は候補にしないでください。
- 日付が表の近くに見えても、その行の対象セル内にあると明確に判断できない場合は除外してください。
- 表の外に書かれた共通メモや、表全体に対する注記として書かれた日付は handwrittenItems に含めないでください。
- 明確に別の欄や完全な欄外メモと判断できる場合は必ず除外してください。

手順2: 候補となる手書きから、納期として使える日付だけを読んでください。
- 「5/8」「2/13」「3月6日」などの日付表記を優先して拾ってください。
- 手書き全文を読めなくても、日付部分が読めるならその数字を最優先で採用してください。
- 5/8 と読めるなら、3/6 や 2/26 など別の日付へ推測で置き換えないでください。

手順3: その日付が複数行に適用されるかを確認してください。
- 「↓」「→」「縦線」「）」「】」のような手書き記号があり、ある日付が複数行にまたがって適用されていると判断できる場合は、その範囲の全行に同じ日付を採用してください。
- 日付が最上段や途中の1行だけに書かれていても、記号が下の行まで続いていれば、つながっている各行に同じ日付を適用してください。
- 範囲記号の終点がチェック記号や曲がり終わりで示されている場合は、そこまでを同じ日付の適用範囲として扱ってください。
- 複数行に同じ日付を適用すると判断した場合でも、handwrittenItems には対象の各行を個別に出力してください。

手順4: 各対象行の itemCode を確定してください。
- 同じ行の品番を itemCode に入れてください。
- 「JANCD」または「JANコード」の列がある場合は、その値を最優先で使ってください。
- それらがない場合のみ「コード」列を使ってください。
- 「発注NO」など他の番号列は使わないでください。
- itemCode は文字列のまま出力してください。
- itemCode は左から右へ1文字ずつ確認し、途中の 0 を省略しないでください。
- たとえば原本が「100103」なら「100103」と出力し、「10013」にしてはいけません。
- itemCode を出力する前に、原本セルを見直して 0 の個数と位置が一致しているか再確認してください。

手順5: 最後に thinking と出力内容を整合させてください。
- thinking には、どの行の備考欄または出荷日回答欄からどの日付を読み、範囲記号があればどの行まで同じ日付を適用したかを書いてください。
- thinking に書いた日付候補は、最終結果にも必ず反映してください。
- 日付を読み取れた行だけを出力してください。
- 手書きの文字がまったくない場合は、handwrittenItems を空配列にしてください。
- PDFが複数ページある場合は、ページごとに pages の配列要素を分けて出力してください。
- 英語は使わないでください。

出力形式（JSONのみ、thinkingも日本語のみ）：

{
  "thinking": "日本語で簡潔に、どの行の備考欄または出荷日回答欄からどの日付を読み、範囲記号があればどの行まで同じ日付を適用したかを書く",
  "pages": [
    {
      "page": 1,
      "handwrittenItems": [
        {
          "itemCode": "対応する商品行の品番（JANCD/JANコードを最優先、なければコード列。たとえば100103は10013にせず出力）",
          "deliveryDate": "手書きの日付（YYYY-MM-DD形式）"
        }
      ]
    }
  ],
  "confidence": "読み取り信頼度（high/medium/low）"
}

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

    // Bedrock Claude に手書き専用プロンプトでPDFを送信
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
      throw new Error("手書きOCR結果からJSONを抽出できませんでした");
    }

    partialResult = {
      ...JSON.parse(jsonMatch[0]),
      processingTimeMs: Date.now() - startedAt,
    };
  } catch (error) {
    console.error("手書きOCR処理エラー:", error);
    partialResult = {
      error: true,
      message: error instanceof Error ? error.message : "Unknown error",
      processingTimeMs: Date.now() - startedAt,
    };
  }

  // 部分結果を書き込み、カウンタが2ならマージ
  try {
    await writePartialAndMergeIfReady({
      jobId,
      partialField: "handwritingResult",
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
