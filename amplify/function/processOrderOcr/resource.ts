import { defineFunction } from "@aws-amplify/backend";

export const processOrderOcr = defineFunction({
  name: "processOrderOcr",
  resourceGroupName: "data",
  runtime: 20,
  timeoutSeconds: 180,
  memoryMB: 4048,
});
