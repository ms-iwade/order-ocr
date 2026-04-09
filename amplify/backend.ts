import { defineBackend } from "@aws-amplify/backend";
import { PolicyStatement, Effect } from "aws-cdk-lib/aws-iam";
import { Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { Duration } from "aws-cdk-lib";
import { auth } from "./auth/resource";
import { data } from "./data/resource";
import { storage } from "./storage/resource";
import { functionWithDataAccess } from "./function/functionWithDataAccess/resource";
import { startOrderOcr } from "./function/startOrderOcr/resource";
import { processOrderOcr } from "./function/processOrderOcr/resource";
import { processHandwritingOcr } from "./function/processHandwritingOcr/resource";

/**
 * Amplify Gen2 Backend Configuration
 *
 * このファイルは、Amplifyバックエンドのエントリーポイントです。
 * 各リソース（認証、データ、ストレージなど）をここで統合します。
 *
 * @see https://docs.amplify.aws/react/build-a-backend/
 */

// ==================================================
// Backend Resources Definition
// ==================================================

const backend = defineBackend({
  auth,
  data,
  storage,
  functionWithDataAccess,
  startOrderOcr,
  processOrderOcr,
  processHandwritingOcr,
});

// ==================================================
// OCR Lambda Functions - IAM & Environment Configuration
// ==================================================

const ocrLambda = backend.processOrderOcr.resources.lambda;
const handwritingLambda = backend.processHandwritingOcr.resources.lambda;
const startOcrLambda = backend.startOrderOcr.resources.lambda;

// processOrderOcr: Bedrock InvokeModel 権限を付与（クロスリージョン推論プロファイル対応）
ocrLambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["bedrock:InvokeModel"],
    resources: [
      "arn:aws:bedrock:*::foundation-model/anthropic.*",
      "arn:aws:bedrock:*:*:inference-profile/us.anthropic.*",
    ],
  })
);

// processOrderOcr: AWS Marketplace 権限を付与（Anthropic モデルのサブスクリプション確認に必要）
ocrLambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      "aws-marketplace:ViewSubscriptions",
      "aws-marketplace:Subscribe",
      "aws-marketplace:Unsubscribe",
    ],
    resources: ["*"],
  })
);

// processHandwritingOcr: Bedrock InvokeModel 権限を付与（クロスリージョン推論プロファイル対応）
handwritingLambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["bedrock:InvokeModel"],
    resources: [
      "arn:aws:bedrock:*::foundation-model/anthropic.*",
      "arn:aws:bedrock:*:*:inference-profile/us.anthropic.*",
    ],
  })
);

// processHandwritingOcr: AWS Marketplace 権限を付与
handwritingLambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: [
      "aws-marketplace:ViewSubscriptions",
      "aws-marketplace:Subscribe",
      "aws-marketplace:Unsubscribe",
    ],
    resources: ["*"],
  })
);

// S3バケットの読み取り権限を付与
const storageBucket = backend.storage.resources.bucket;
storageBucket.grantRead(ocrLambda);
storageBucket.grantRead(handwritingLambda);

// S3バケット名を環境変数に設定
(ocrLambda as LambdaFunction).addEnvironment("S3_BUCKET_NAME", storageBucket.bucketName);
(handwritingLambda as LambdaFunction).addEnvironment("S3_BUCKET_NAME", storageBucket.bucketName);

// startOrderOcr: processOrderOcr・processHandwritingOcr Lambdaの非同期起動権限を付与
startOcrLambda.addToRolePolicy(
  new PolicyStatement({
    effect: Effect.ALLOW,
    actions: ["lambda:InvokeFunction"],
    resources: [ocrLambda.functionArn, handwritingLambda.functionArn],
  })
);

// startOrderOcr: Lambda関数名を環境変数に設定
(startOcrLambda as LambdaFunction).addEnvironment(
  "OCR_FUNCTION_NAME",
  (ocrLambda as LambdaFunction).functionName
);
(startOcrLambda as LambdaFunction).addEnvironment(
  "HANDWRITING_FUNCTION_NAME",
  (handwritingLambda as LambdaFunction).functionName
);

// ==================================================
// OcrJob DynamoDB テーブルへの直接アクセス権限（アトミックカウンタ用）
// ==================================================

const ocrJobTable = backend.data.resources.tables['OcrJob'];

// processOrderOcr・processHandwritingOcr: DynamoDB UpdateItem 権限
ocrJobTable.grantWriteData(ocrLambda);
ocrJobTable.grantWriteData(handwritingLambda);

// OcrJobテーブル名を環境変数に設定
(ocrLambda as LambdaFunction).addEnvironment("OCRJOB_TABLE_NAME", ocrJobTable.tableName);
(handwritingLambda as LambdaFunction).addEnvironment("OCRJOB_TABLE_NAME", ocrJobTable.tableName);

// ==================================================
// OcrJob DynamoDB TTL設定（24時間後に自動削除）
// ==================================================

backend.data.resources.cfnResources.amplifyDynamoDbTables['OcrJob'].timeToLiveAttribute = {
  enabled: true,
  attributeName: 'ttl',
};

// ==================================================
// S3 ライフサイクルルール（order-forms/ 配下を1日後に自動削除）
// ==================================================

import { Bucket } from "aws-cdk-lib/aws-s3";
(storageBucket as Bucket).addLifecycleRule({
  prefix: 'order-forms/',
  expiration: Duration.days(1),
});

// ==================================================
// Cognito User Pool Configuration
// ==================================================

/**
 * Cognito User Poolの詳細設定
 * L1 Constructを使用して、より細かい設定を行います
 * SSOの設定を行う場合は以下を参考にしてください。
 * @see https://trust-coms.atlassian.net/wiki/spaces/DX/pages/944177657/Amplify+Cognito+Hosted+UI+SSO
 */
const { cfnUserPool } = backend.auth.resources.cfnResources;

// ユーザー名でのログインを有効化
cfnUserPool.usernameAttributes = [];

// パスワードポリシーの設定
cfnUserPool.policies = {
  passwordPolicy: {
    minimumLength: 6, // パスワードの最小文字数
    requireLowercase: true, // 小文字
    requireNumbers: true, // 数字
    requireSymbols: false, // 記号
    requireUppercase: false, // 大文字
    temporaryPasswordValidityDays: 7, // 一時パスワードの有効期間
  },
};
