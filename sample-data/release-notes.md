# QueuePilot Release Notes

## Version 0.1 highlights

QueuePilot now supports **three job types**: CSV summaries, text analytics and data validation. Every job is processed asynchronously by an AWS Lambda worker that reads messages from an Amazon SQS queue.

## Reliability

- Failed attempts are retried with exponential backoff.
- Jobs that keep failing are moved to a [dead-letter queue](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html) for inspection.
- Operators can retry a single job with corrected parameters or redrive the entire dead-letter queue.

```bash
# code blocks are ignored by the text analyzer
npm run build
```

## Known limitations

The dashboard polls the API every few seconds rather than receiving push updates, which is simple and inexpensive but means status changes can take a moment to appear. Very large files above five megabytes are rejected at upload time by the storage policy itself, before any processing cost is incurred.
