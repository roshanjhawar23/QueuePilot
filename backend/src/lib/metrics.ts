/**
 * Custom CloudWatch metrics using the Embedded Metric Format (EMF).
 *
 * Writing a specially shaped JSON log line is enough: CloudWatch Logs extracts the metric
 * automatically. No PutMetricData API call or extra IAM permission is needed.
 * One fixed dimension keeps the number of custom metrics small (cost control).
 */
export const METRIC_NAMESPACE = 'QueuePilot';

export type MetricName =
  | 'JobsSubmitted'
  | 'JobsSucceeded'
  | 'JobsFailed'
  | 'JobsDeadLettered'
  | 'JobRetriesScheduled'
  | 'StaleMessagesDiscarded'
  | 'JobDurationMs';

export function emitMetric(name: MetricName, value: number, unit: 'Count' | 'Milliseconds' = 'Count'): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: METRIC_NAMESPACE, Dimensions: [['Service']], Metrics: [{ Name: name, Unit: unit }] }],
      },
      Service: 'QueuePilot',
      [name]: value,
    }),
  );
}
