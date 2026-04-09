# 発注書OCR機能 実装計画

## 概要
新越ワークスの受取注文書（発注書）を、Amazon Bedrock Claude を使って自動OCRする機能。
フォーマット指定不要で、PDFや画像をアップロードするだけで発注書の内容を構造化データとして抽出する。

## 背景
- `docs/新越ワークス受取注文書(15)/` に8件のサンプル発注書（PDF）が存在
- 各仕入先でフォーマットが異なるため、フォーマット指定なしで汎用的にOCR処理を行う必要がある
- 既存のAmplify Gen2インフラ（Cognito認証、S3、AppSync、Lambda）を活用して構築

## アーキテクチャ

```
[ブラウザ] → [S3アップロード] → [AppSync Mutation] → [Lambda] → [Bedrock Claude] → [結果返却]
```

### 処理フロー
1. ユーザーがブラウザからPDF/画像をアップロード
2. `order-forms/{identityId}/` パスでS3に保存
3. `processOrderOcr` AppSyncミューテーションを呼び出し
4. Lambda関数がS3からPDFを取得、base64エンコード
5. Bedrock Claude（Sonnet）にdocument content blockとして送信
6. Claudeが発注書の内容を読み取り、構造化JSONで返却
7. フロントエンドで結果をテーブル表示

## 技術選定

| 項目 | 選択 | 理由 |
|------|------|------|
| OCRエンジン | Amazon Bedrock Claude (Vision) | フォーマット指定不要、日本語対応、PDF直接処理可能 |
| PDF処理方式 | Bedrock document content block | PDF→画像変換ライブラリ不要、Lambda依存を最小化 |
| モデル | Claude Sonnet (`anthropic.claude-sonnet-4-20250514-v1:0`) | 精度とコストのバランス |
| リージョン | ap-northeast-1（東京） | 既存インフラと同一リージョン |
| アーキテクチャ | AppSync → Lambda → Bedrock | 同期処理でシンプル、既存パターンに準拠 |
| Lambda設定 | timeout: 120秒 / memory: 512MB | Bedrock応答に十分な余裕を確保 |

## OCR出力データ構造

```typescript
interface OcrResult {
  supplierName: string | null;    // 発注先（仕入先）
  orderNumber: string | null;     // 注文番号
  orderDate: string | null;       // 発注日（YYYY-MM-DD）
  deliveryDate: string | null;    // 納期（YYYY-MM-DD）
  buyerName: string | null;       // 発注元
  lineItems: Array<{
    itemCode: string | null;      // 品番
    itemName: string | null;      // 品名
    quantity: number | null;       // 数量
    unit: string | null;          // 単位
    unitPrice: number | null;     // 単価
    amount: number | null;        // 金額
    remarks: string | null;       // 備考
  }>;
  subtotal: number | null;        // 小計
  tax: number | null;             // 消費税
  totalAmount: number | null;     // 合計金額
  notes: string | null;           // 備考・特記事項
  confidence: 'high' | 'medium' | 'low';  // 読み取り信頼度
}
```

## 変更対象ファイル一覧

### 新規作成
| ファイル | 内容 |
|----------|------|
| `amplify/function/processOrderOcr/resource.ts` | Lambda関数定義（timeout: 120s, memory: 512MB） |
| `amplify/function/processOrderOcr/handler.ts` | OCR処理ハンドラー（S3→Bedrock→JSON返却） |
| `src/features/ocr/OcrPage.tsx` | OCRメインページ |
| `src/features/ocr/components/FileUploader.tsx` | ドラッグ&ドロップファイルアップロード |
| `src/features/ocr/components/OcrResultDisplay.tsx` | OCR結果テーブル表示 |
| `src/features/ocr/hooks/useOcrProcess.ts` | S3アップロード + ミューテーション呼び出しフック |
| `src/features/ocr/types/ocr.ts` | OcrResult型定義 |

### 変更
| ファイル | 変更内容 |
|----------|----------|
| `amplify/data/resource.ts` | `processOrderOcr`ミューテーション追加 |
| `amplify/backend.ts` | Lambda登録、Bedrock IAMポリシー、S3環境変数設定 |
| `amplify/storage/resource.ts` | `order-forms/{entity_id}/*` パス追加 |
| `src/config/routes.ts` | `/ocr` ルート追加 |
| `src/config/navigationConfig.tsx` | 「発注書OCR」ナビゲーション追加 |

## IAMポリシー

Lambda関数に以下の権限を付与:
- `bedrock:InvokeModel` - `arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.*`
- S3バケット読み取り権限（`grantRead`）

## 検証方法

1. `npx ampx sandbox` でローカルサンドボックス起動
2. ブラウザでログイン → サイドメニューから「発注書OCR」へ遷移
3. `docs/新越ワークス受取注文書(15)/` 内のPDFをドラッグ&ドロップでアップロード
4. OCR結果が構造化テーブルとして表示されることを確認
5. 8件全てのPDF（異なるフォーマット）で正しく読み取れるか検証

## 注意事項

- Bedrock Claudeのdocument content blockはPDFを直接処理可能（最大100ページ）
- PDFのbase64エンコード後のサイズがBedrock制限（約25MB）以内であることが前提
- 読み取れない項目は `null` で返却される設計
- モデルの精度検証後、必要に応じてプロンプト調整やモデル変更（Haiku等）を検討
