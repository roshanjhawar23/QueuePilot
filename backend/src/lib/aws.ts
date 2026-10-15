import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';

/**
 * AWS SDK v3 clients, created once per Lambda container and reused across invocations.
 * No credentials appear in code: on Lambda the SDK uses the function's IAM execution role.
 */
const region = process.env.AWS_REGION ?? 'us-east-1';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});
export const s3 = new S3Client({ region });
export const sqs = new SQSClient({ region });
