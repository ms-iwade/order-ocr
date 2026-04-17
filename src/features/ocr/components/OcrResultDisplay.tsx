import {
  Alert,
  Box,
  Chip,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import TableChartIcon from "@mui/icons-material/TableChart";
import EditIcon from "@mui/icons-material/Edit";
import Tooltip from "@mui/material/Tooltip";
import type { OcrResult } from "../types/ocr";

interface OcrResultDisplayProps {
  result: OcrResult;
  fileName: string;
}

function formatProcessingTime(processingTimeMs?: number): string {
  if (processingTimeMs == null) {
    return "-";
  }

  if (processingTimeMs < 1000) {
    return `${processingTimeMs} ms`;
  }

  return `${(processingTimeMs / 1000).toFixed(2)} 秒`;
}

export function OcrResultDisplay({ result, fileName }: OcrResultDisplayProps) {
  const confidenceColor =
    result.confidence === "high"
      ? "success"
      : result.confidence === "medium"
        ? "warning"
        : "error";

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <Paper sx={{ p: 2 }}>
        <Box
          sx={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            mb: 1,
          }}
        >
          <Typography variant="h6">OCR結果</Typography>
          <Chip
            label={`信頼度: ${result.confidence}`}
            color={confidenceColor}
            size="small"
          />
        </Box>
        <Typography variant="body2" color="text.secondary">
          ファイル: {fileName}
        </Typography>
        <Box sx={{ display: "flex", gap: 1, mt: 1, flexWrap: "wrap" }}>
          <Chip
            label={`テーブルOCR: ${formatProcessingTime(result.tableProcessingTimeMs)}`}
            size="small"
            variant="outlined"
            icon={<TableChartIcon />}
          />
          <Chip
            label={`手書きOCR: ${formatProcessingTime(result.handwritingProcessingTimeMs)}`}
            size="small"
            variant="outlined"
            icon={<EditIcon />}
          />
        </Box>
      </Paper>

      {result.errorMessage && (
        <Alert severity="warning">{result.errorMessage}</Alert>
      )}

      {result.pages?.map((page) => (
        <Box key={page.page}>
          {result.pages.length > 1 && (
            <Typography
              variant="subtitle2"
              color="text.secondary"
              sx={{ mb: 1 }}
            >
              ページ {page.page}
            </Typography>
          )}
          {page.lineItems && page.lineItems.length > 0 && (
            <TableContainer component={Paper}>
              <Table size="small" sx={{ tableLayout: "fixed" }}>
                <TableHead>
                  <TableRow sx={{ bgcolor: "grey.200" }}>
                    <TableCell align="center" sx={{ width: "25%" }}>
                      品番
                    </TableCell>
                    <TableCell align="center" sx={{ width: "18%" }}>
                      発注数
                    </TableCell>
                    <TableCell align="center" sx={{ width: "27%" }}>
                      納期
                    </TableCell>
                    <TableCell align="center" sx={{ width: "30%" }}>
                      手書き
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {page.lineItems.map((item, index) => (
                    <TableRow key={index}>
                      <TableCell align="center">
                        {item.itemCode ?? "-"}
                      </TableCell>
                      <TableCell align="center">
                        {item.quantity != null
                          ? item.quantity.toLocaleString()
                          : "-"}
                      </TableCell>
                      <TableCell align="center">
                        <Box
                          sx={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 0.5,
                          }}
                        >
                          {item.deliveryDate ?? "-"}
                          {item.deliveryDateSource === "handwritten" && (
                            <Tooltip title="手書きで読み取った日付を採用">
                              <EditIcon
                                fontSize="small"
                                color="warning"
                                sx={{ fontSize: 16 }}
                              />
                            </Tooltip>
                          )}
                        </Box>
                      </TableCell>
                      <TableCell align="center">
                        {item.handwrittenDeliveryDate ?? "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Box>
      ))}
    </Box>
  );
}
