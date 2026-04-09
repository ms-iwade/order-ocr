import { Container, Alert, Button, Box, Grid } from '@mui/material';
import { FileUploader } from './components/FileUploader';
import { FilePreview } from './components/FilePreview';
import { OcrResultDisplay } from './components/OcrResultDisplay';
import { useOcrProcess } from './hooks/useOcrProcess';

export default function OcrPage() {
  const { processFile, processing, result, error, fileName, previewUrl, fileType, reset } =
    useOcrProcess();

  const hasResult = result && fileName && previewUrl && fileType;

  return (
    <Container maxWidth="xl">
      <FileUploader onFileSelect={processFile} processing={processing} />

      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}

      {hasResult && (
        <Box sx={{ mt: 2 }}>
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
            <Button variant="outlined" size="small" onClick={reset}>
              クリア
            </Button>
          </Box>
          <Grid container spacing={2}>
            <Grid size={{ xs: 12, md: 6 }}>
              <FilePreview
                previewUrl={previewUrl}
                fileType={fileType}
                fileName={fileName}
              />
            </Grid>
            <Grid size={{ xs: 12, md: 6 }}>
              <OcrResultDisplay result={result} fileName={fileName} />
            </Grid>
          </Grid>
        </Box>
      )}
    </Container>
  );
}
