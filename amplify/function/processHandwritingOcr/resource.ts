import { defineFunction } from "@aws-amplify/backend";

export const processHandwritingOcr = defineFunction({
  name: "processHandwritingOcr",
  resourceGroupName: "data",
  runtime: 20,
  timeoutSeconds: 180,
  memoryMB: 4048,
});
