import { useCallback, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  CircularProgress,
} from '@mui/material';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';

interface FileUploaderProps {
  onFileSelect: (file: File) => void;
  processing: boolean;
}

export function FileUploader({ onFileSelect, processing }: FileUploaderProps) {
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (processing) return;

      const file = e.dataTransfer.files[0];
      if (file && isAcceptedFile(file)) {
        onFileSelect(file);
      }
    },
    [onFileSelect, processing]
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file && isAcceptedFile(file)) {
        onFileSelect(file);
      }
      // inputをリセットして同じファイルを再選択可能にする
      e.target.value = '';
    },
    [onFileSelect]
  );

  return (
    <Paper
      variant="outlined"
      onDragOver={(e) => {
        e.preventDefault();
        if (!processing) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      sx={{
        p: 4,
        textAlign: 'center',
        cursor: processing ? 'not-allowed' : 'pointer',
        borderStyle: 'dashed',
        borderWidth: 2,
        borderColor: dragOver ? 'primary.main' : 'divider',
        bgcolor: dragOver ? 'action.hover' : 'background.paper',
        transition: 'all 0.2s ease',
        '&:hover': processing
          ? {}
          : { borderColor: 'primary.main', bgcolor: 'action.hover' },
      }}
      onClick={() => {
        if (!processing) {
          document.getElementById('ocr-file-input')?.click();
        }
      }}
    >
      <input
        id="ocr-file-input"
        type="file"
        accept=".pdf,.jpg,.jpeg,.png"
        hidden
        onChange={handleFileInput}
        disabled={processing}
      />

      {processing ? (
        <Box>
          <CircularProgress size={48} sx={{ mb: 2 }} />
          <Typography variant="body1" color="text.secondary">
            OCR処理中...しばらくお待ちください
          </Typography>
        </Box>
      ) : (
        <Box>
          <CloudUploadOutlinedIcon
            sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }}
          />
          <Typography variant="body1" gutterBottom>
            発注書をドラッグ&ドロップ、またはクリックして選択
          </Typography>
          <Typography variant="body2" color="text.secondary">
            対応形式: PDF, JPG, PNG
          </Typography>
        </Box>
      )}
    </Paper>
  );
}

function isAcceptedFile(file: File): boolean {
  const accepted = [
    'application/pdf',
    'image/jpeg',
    'image/png',
  ];
  return accepted.includes(file.type);
}
