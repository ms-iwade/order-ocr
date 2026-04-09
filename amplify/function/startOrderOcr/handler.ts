import type { Schema } from '../../data/resource';
import { Amplify } from 'aws-amplify';
import { generateClient } from 'aws-amplify/data';
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime';
import { env } from '$amplify/env/startOrderOcr';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(env);
Amplify.configure(resourceConfig, libraryOptions);

const client = generateClient<Schema>();
const lambda = new LambdaClient({});

/**
 * 発注書OCR開始ハンドラー
 * OcrJobレコードを作成し、processOrderOcr Lambdaを非同期で起動する
 */
export const handler: Schema['startOrderOcr']['functionHandler'] = async (
  event
) => {
  const { s3Key, fileName } = event.arguments;

  try {
    // OcrJobレコードを作成（PROCESSING状態、24時間後に自動削除）
    const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const { data: job, errors } = await client.models.OcrJob.create({
      s3Key,
      fileName,
      status: 'PROCESSING',
      subJobCount: 0,
      ttl,
    });

    if (errors || !job) {
      throw new Error(`OcrJob作成失敗: ${JSON.stringify(errors)}`);
    }

    // processOrderOcr と processHandwritingOcr を並列で非同期起動
    const payload = JSON.stringify({
      jobId: job.id,
      s3Key,
      fileName,
    });

    await Promise.all([
      lambda.send(
        new InvokeCommand({
          FunctionName: process.env.OCR_FUNCTION_NAME,
          InvocationType: 'Event',
          Payload: payload,
        })
      ),
      lambda.send(
        new InvokeCommand({
          FunctionName: process.env.HANDWRITING_FUNCTION_NAME,
          InvocationType: 'Event',
          Payload: payload,
        })
      ),
    ]);

    return {
      jobId: job.id,
      status: 'PROCESSING',
    };
  } catch (error) {
    console.error('OCRジョブ開始エラー:', error);
    return {
      jobId: null,
      status: 'FAILED',
      errorMessage:
        error instanceof Error ? error.message : 'Unknown error occurred',
    };
  }
};
