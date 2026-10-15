import {
  ChangeMessageVisibilityCommand,
  GetQueueAttributesCommand,
  ListMessageMoveTasksCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  StartMessageMoveTaskCommand,
} from '@aws-sdk/client-sqs';
import type { QueueDepth, RedriveTask } from '@queuepilot/shared';
import { sqs } from './aws.js';
import { getConfig } from './config.js';

/** The SQS message body. It is deliberately tiny: the job record in DynamoDB is the source of truth. */
export interface JobMessage {
  jobId: string;
  dispatchId: string;
  enqueuedAt: string;
}

export function parseJobMessage(body: string): JobMessage | null {
  try {
    const m = JSON.parse(body) as Partial<JobMessage>;
    if (typeof m.jobId === 'string' && typeof m.dispatchId === 'string') {
      return { jobId: m.jobId, dispatchId: m.dispatchId, enqueuedAt: String(m.enqueuedAt ?? '') };
    }
  } catch {
    /* fall through */
  }
  return null;
}

export async function enqueueJob(jobId: string, dispatchId: string, jobType: string): Promise<string | undefined> {
  const body: JobMessage = { jobId, dispatchId, enqueuedAt: new Date().toISOString() };
  const res = await sqs.send(
    new SendMessageCommand({
      QueueUrl: getConfig().queueUrl,
      MessageBody: JSON.stringify(body),
      MessageAttributes: { jobType: { DataType: 'String', StringValue: jobType } },
    }),
  );
  return res.MessageId;
}

/** Hides the message for `seconds` before SQS delivers it again (used for retry backoff). */
export async function delayRedelivery(receiptHandle: string, seconds: number): Promise<void> {
  await sqs.send(
    new ChangeMessageVisibilityCommand({ QueueUrl: getConfig().queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }),
  );
}

export async function getQueueDepth(queueUrl: string): Promise<QueueDepth> {
  const res = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed'],
    }),
  );
  const a = res.Attributes ?? {};
  return {
    visible: Number(a.ApproximateNumberOfMessages ?? 0),
    inFlight: Number(a.ApproximateNumberOfMessagesNotVisible ?? 0),
    delayed: Number(a.ApproximateNumberOfMessagesDelayed ?? 0),
  };
}

/**
 * Reads up to 10 DLQ messages WITHOUT removing them (VisibilityTimeout 0 makes them visible again
 * immediately). SQS short polling samples a subset of servers, so this is a preview, not a full list.
 */
export async function peekDlq(): Promise<{ messageId: string; body: string; receiveCount: number; sentAt: string | null }[]> {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: getConfig().dlqUrl,
      MaxNumberOfMessages: 10,
      VisibilityTimeout: 0,
      WaitTimeSeconds: 0,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'SentTimestamp'],
    }),
  );
  return (res.Messages ?? []).map((m) => ({
    messageId: m.MessageId ?? '',
    body: m.Body ?? '',
    receiveCount: Number(m.Attributes?.ApproximateReceiveCount ?? 0),
    sentAt: m.Attributes?.SentTimestamp ? new Date(Number(m.Attributes.SentTimestamp)).toISOString() : null,
  }));
}

/** Native SQS DLQ redrive: moves every message from the DLQ back to the main queue. */
export async function startRedrive(): Promise<string | undefined> {
  const cfg = getConfig();
  const res = await sqs.send(
    new StartMessageMoveTaskCommand({ SourceArn: cfg.dlqArn, DestinationArn: cfg.queueArn, MaxNumberOfMessagesPerSecond: 10 }),
  );
  return res.TaskHandle;
}

export async function listRedriveTasks(): Promise<RedriveTask[]> {
  const res = await sqs.send(new ListMessageMoveTasksCommand({ SourceArn: getConfig().dlqArn, MaxResults: 5 }));
  return (res.Results ?? []).map((t) => ({
    taskHandle: t.TaskHandle ?? null,
    status: t.Status ?? 'UNKNOWN',
    approximateNumberOfMessagesMoved: Number(t.ApproximateNumberOfMessagesMoved ?? 0),
    approximateNumberOfMessagesToMove: t.ApproximateNumberOfMessagesToMove === undefined ? null : Number(t.ApproximateNumberOfMessagesToMove),
    startedAt: t.StartedTimestamp ? new Date(Number(t.StartedTimestamp)).toISOString() : null,
    failureReason: t.FailureReason ?? null,
  }));
}
