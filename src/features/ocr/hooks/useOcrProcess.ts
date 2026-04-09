import { useState, useEffect, useRef, useCallback } from 'react';
import { uploadData } from 'aws-amplify/storage';
import { fetchAuthSession } from 'aws-amplify/auth';
import { client } from '@shared/clients/amplify';
import type { OcrResult } from '../types/ocr';

interface UseOcrProcessReturn {
  processFile: (file: File) => Promise<void>;
  processing: boolean;
  result: OcrResult | null;
  error: string | null;
  fileName: string | null;
  previewUrl: string | null;
  fileType: string | null;
  reset: () => void;
}

export function useOcrProcess(): UseOcrProcessReturn {
  const [processing, setProcessing] = useState(false);
  const [result, setResult] = useState<OcrResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileType, setFileType] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const subscriptionRef = useRef<{ unsubscribe: () => void } | null>(null);

  // クリーンアップ
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) {
        URL.revokeObjectURL(previewUrlRef.current);
      }
      subscriptionRef.current?.unsubscribe();
    };
  }, []);

  const handleJobUpdate = useCallback((jobId: string) => {
    // OcrJobの更新をSubscriptionで監視
    const sub = client.models.OcrJob.onUpdate({
      filter: { id: { eq: jobId } },
    }).subscribe({
      next: (updatedJob) => {
        if (updatedJob.status === 'COMPLETED' && updatedJob.result) {
          const parsed: OcrResult =
            typeof updatedJob.result === 'string'
              ? JSON.parse(updatedJob.result)
              : updatedJob.result as unknown as OcrResult;
          setResult(parsed);
          setProcessing(false);
          sub.unsubscribe();
        } else if (updatedJob.status === 'FAILED') {
          setError(updatedJob.errorMessage || 'OCR処理に失敗しました');
          setProcessing(false);
          sub.unsubscribe();
        }
      },
      error: (err) => {
        console.error('Subscription error:', err);
        setError('リアルタイム通知でエラーが発生しました');
        setProcessing(false);
      },
    });

    subscriptionRef.current = sub;
  }, []);

  const processFile = async (file: File) => {
    // 前回のSubscriptionをクリーンアップ
    subscriptionRef.current?.unsubscribe();

    setProcessing(true);
    setError(null);
    setResult(null);
    setFileName(file.name);

    // プレビューURL生成（既存があればrevoke）
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
    const url = URL.createObjectURL(file);
    previewUrlRef.current = url;
    setPreviewUrl(url);
    setFileType(file.type);

    try {
      // 認証セッションからidentityIdを取得
      const session = await fetchAuthSession();
      const identityId = session.identityId;
      if (!identityId) {
        throw new Error('認証情報を取得できませんでした');
      }

      // S3にアップロード
      const s3Key = `order-forms/${identityId}/${Date.now()}_${file.name}`;
      await uploadData({
        path: s3Key,
        data: file,
        options: {
          contentType: file.type || 'application/pdf',
        },
      }).result;

      // OCRジョブ開始ミューテーション呼び出し（即座に返る）
      const response = await client.mutations.startOrderOcr({
        s3Key,
        fileName: file.name,
      });

      if (response.errors && response.errors.length > 0) {
        const errorMessages = response.errors.map((e) => e.message).join(', ');
        throw new Error(`GraphQLエラー: ${errorMessages}`);
      }

      const raw = response.data;
      const data = typeof raw === 'string' ? JSON.parse(raw) : raw as Record<string, unknown>;

      if (data?.status === 'FAILED') {
        throw new Error((data.errorMessage as string) || 'OCRジョブの開始に失敗しました');
      }

      const jobId = data?.jobId as string;
      if (!jobId) {
        throw new Error('ジョブIDを取得できませんでした');
      }

      // Subscriptionで結果を監視
      handleJobUpdate(jobId);
    } catch (err) {
      console.error('OCR処理エラー:', err);
      setError(err instanceof Error ? err.message : 'エラーが発生しました');
      setProcessing(false);
    }
  };

  const reset = () => {
    subscriptionRef.current?.unsubscribe();
    subscriptionRef.current = null;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setResult(null);
    setError(null);
    setFileName(null);
    setPreviewUrl(null);
    setFileType(null);
  };

  return { processFile, processing, result, error, fileName, previewUrl, fileType, reset };
}
