import { defineFunction } from '@aws-amplify/backend';

export const startOrderOcr = defineFunction({
  name: 'startOrderOcr',
  resourceGroupName: 'data',
  runtime: 20,
  timeoutSeconds: 10,
  memoryMB: 256,
});
