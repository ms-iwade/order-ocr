import { Box, Paper, Typography } from "@mui/material";

interface FilePreviewProps {
  previewUrl: string;
  fileType: string;
  fileName: string;
}

export function FilePreview({
  previewUrl,
  fileType,
  fileName,
}: FilePreviewProps) {
  const isPdf = fileType === "application/pdf";

  return (
    <Paper
      sx={{ p: 2, height: "100%", display: "flex", flexDirection: "column" }}
    >
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
        原本プレビュー: {fileName}
      </Typography>
      <Box sx={{ flex: 1, minHeight: 500, overflow: "auto" }}>
        {isPdf ? (
          <iframe
            src={previewUrl}
            title="PDF Preview"
            style={{
              width: "100%",
              height: "100%",
              minHeight: 500,
              border: "none",
            }}
          />
        ) : (
          <img
            src={previewUrl}
            alt={fileName}
            style={{ width: "100%", height: "auto", objectFit: "contain" }}
          />
        )}
      </Box>
    </Paper>
  );
}
