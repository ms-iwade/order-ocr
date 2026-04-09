import { type ClientSchema, a, defineData } from "@aws-amplify/backend";
import { functionWithDataAccess } from "../function/functionWithDataAccess/resource";
import { startOrderOcr } from "../function/startOrderOcr/resource";
import { processOrderOcr } from "../function/processOrderOcr/resource";
import { processHandwritingOcr } from "../function/processHandwritingOcr/resource";

const schema = a.schema({
  Todo: a
    .model({
      content: a.string(),
      status: a.enum(["PENDING", "COMPLETED"]),
      createdAt: a.datetime(),
    })
    .secondaryIndexes((index) => [
      // ステータス別にTodoを作成日時順で検索するためのIndex
      index("status").sortKeys(["createdAt"]).queryField("todosByStatus"),
    ])
    .authorization((allow) => [allow.authenticated()]),

  // OCRジョブモデル（非同期処理の状態管理、TTLで24時間後に自動削除）
  OcrJob: a
    .model({
      s3Key: a.string().required(),
      fileName: a.string().required(),
      status: a.enum(["PROCESSING", "COMPLETED", "FAILED"]),
      result: a.json(),
      tableResult: a.json(),
      handwritingResult: a.json(),
      subJobCount: a.integer(),
      errorMessage: a.string(),
      ttl: a.integer(),
    })
    .authorization((allow) => [allow.authenticated()]),

  // カスタムミューテーション
  createCustomTodo: a
    .mutation()
    .arguments({
      content: a.string().required(),
      status: a.enum(["PENDING", "COMPLETED"]),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(functionWithDataAccess)),

  // 発注書OCR開始ミューテーション（非同期：即座にジョブIDを返す）
  startOrderOcr: a
    .mutation()
    .arguments({
      s3Key: a.string().required(),
      fileName: a.string().required(),
    })
    .returns(a.json())
    .authorization((allow) => [allow.authenticated()])
    .handler(a.handler.function(startOrderOcr)),
})
.authorization(allow => [
  allow.resource(functionWithDataAccess).to(["mutate"]),
  allow.resource(startOrderOcr).to(["mutate", "query"]),
  allow.resource(processOrderOcr).to(["mutate", "query"]),
  allow.resource(processHandwritingOcr).to(["mutate", "query"]),
]);

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: "userPool",
  },
});
