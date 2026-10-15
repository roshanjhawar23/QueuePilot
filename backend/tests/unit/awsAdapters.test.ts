/**
 * Checks the SQS and S3 requests the adapters build. Uses aws-sdk-client-mock and DUMMY
 * credentials (needed only so the SDK can compute signatures locally). Nothing is sent to AWS.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  ChangeMessageVisibilityCommand,
  ListMessageMoveTasksCommand,
  ReceiveMessageCommand,
  SQSClient,
  SendMessageCommand,
  StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { setTestEnv } from './fakes.js';

beforeAll(() => {
  process.env.AWS_ACCESS_KEY_ID = 'AKIDUNITTESTONLY';
  process.env.AWS_SECRET_ACCESS_KEY = 'unit-test-dummy-secret';
});

const sqsMock = mockClient(SQSClient);
const s3Mock = mockClient(S3Client);
const queue = await import('../../src/lib/queue.js');
const storage = await import('../../src/lib/storage.js');

beforeEach(() => {
  setTestEnv();
  sqsMock.reset();
  s3Mock.reset();
});

describe('SQS adapter', () => {
  it('sends a small JSON message with jobId and dispatchId only', async () => {
    sqsMock.on(SendMessageCommand).resolves({ MessageId: 'm1' });
    await queue.enqueueJob('j1', 'd1', 'csv.summary');
    const input = sqsMock.commandCalls(SendMessageCommand)[0]!.args[0].input;
    expect(input.QueueUrl).toBe(process.env.QUEUE_URL);
    expect(JSON.parse(input.MessageBody!)).toMatchObject({ jobId: 'j1', dispatchId: 'd1' });
  });

  it('applies backoff with ChangeMessageVisibility on the main queue', async () => {
    sqsMock.on(ChangeMessageVisibilityCommand).resolves({});
    await queue.delayRedelivery('rh', 20);
    expect(sqsMock.commandCalls(ChangeMessageVisibilityCommand)[0]!.args[0].input).toEqual({
      QueueUrl: process.env.QUEUE_URL,
      ReceiptHandle: 'rh',
      VisibilityTimeout: 20,
    });
  });

  it('peeks the DLQ without hiding messages (VisibilityTimeout 0)', async () => {
    sqsMock.on(ReceiveMessageCommand).resolves({
      Messages: [{ MessageId: 'x', Body: '{"jobId":"j","dispatchId":"d"}', Attributes: { ApproximateReceiveCount: '4', SentTimestamp: '1791000000000' } }],
    });
    const msgs = await queue.peekDlq();
    const input = sqsMock.commandCalls(ReceiveMessageCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ QueueUrl: process.env.DLQ_URL, VisibilityTimeout: 0 });
    expect(msgs[0]).toMatchObject({ messageId: 'x', receiveCount: 4 });
  });

  it('redrives with StartMessageMoveTask from the DLQ ARN to the main queue ARN', async () => {
    sqsMock.on(StartMessageMoveTaskCommand).resolves({ TaskHandle: 't' });
    expect(await queue.startRedrive()).toBe('t');
    expect(sqsMock.commandCalls(StartMessageMoveTaskCommand)[0]!.args[0].input).toEqual({
      SourceArn: process.env.DLQ_ARN,
      DestinationArn: process.env.QUEUE_ARN,
      MaxNumberOfMessagesPerSecond: 10,
    });
    sqsMock.on(ListMessageMoveTasksCommand).resolves({ Results: [{ Status: 'COMPLETED', ApproximateNumberOfMessagesMoved: 2 }] });
    expect((await queue.listRedriveTasks())[0]).toMatchObject({ status: 'COMPLETED', approximateNumberOfMessagesMoved: 2 });
  });

  it('parses only well-formed job messages', () => {
    expect(queue.parseJobMessage('{"jobId":"a","dispatchId":"b"}')).toMatchObject({ jobId: 'a', dispatchId: 'b' });
    expect(queue.parseJobMessage('{"jobId":1}')).toBeNull();
    expect(queue.parseJobMessage('nope')).toBeNull();
  });
});

describe('S3 adapter', () => {
  it('builds a presigned POST whose policy enforces the 5 MB limit, exact key and content type', async () => {
    const post = await storage.presignUpload('inputs/u/a.csv', 'text/csv');
    expect(post.url).toContain('test-bucket');
    expect(post.fields.key).toBe('inputs/u/a.csv');
    const policy = JSON.parse(Buffer.from(post.fields.Policy!, 'base64').toString('utf8'));
    expect(policy.conditions).toContainEqual(['content-length-range', 1, 5 * 1024 * 1024]);
    expect(policy.conditions).toContainEqual(['eq', '$Content-Type', 'text/csv']);
    expect(policy.conditions).toContainEqual({ key: 'inputs/u/a.csv' });
  });

  it('writes outputs with a SHA-256 checksum that S3 verifies', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    await storage.putObject('outputs/j/result.json', '{}', 'application/json');
    const input = s3Mock.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ Bucket: 'test-bucket', Key: 'outputs/j/result.json', ContentType: 'application/json' });
    expect(input.ChecksumSHA256).toBe(Buffer.from(storage.sha256Hex('{}'), 'hex').toString('base64'));
  });

  it('creates time-limited download links', async () => {
    const url = await storage.presignDownload('outputs/j/result.json', 'result.json');
    expect(url).toContain('X-Amz-Expires=900');
    expect(url).toContain('response-content-disposition');
  });

  it('recognises S3 not-found errors', () => {
    expect(storage.isNotFound({ name: 'NoSuchKey' })).toBe(true);
    expect(storage.isNotFound({ $metadata: { httpStatusCode: 404 } })).toBe(true);
    expect(storage.isNotFound(new Error('x'))).toBe(false);
  });
});
