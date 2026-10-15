import type { CsvSummaryParams, DataValidateParams, JobParams, JobType, TextAnalyticsParams } from '@queuepilot/shared';
import { csvSummary } from './csvSummary.js';
import { dataValidate } from './dataValidate.js';
import { textAnalytics } from './textAnalytics.js';
import type { ProcessorOutput } from './types.js';

export function runProcessor(type: JobType, body: Uint8Array, fileName: string, params: JobParams): ProcessorOutput {
  switch (type) {
    case 'csv.summary':
      return csvSummary({ body, fileName, params: params as CsvSummaryParams });
    case 'text.analytics':
      return textAnalytics({ body, fileName, params: params as TextAnalyticsParams });
    case 'data.validate':
      return dataValidate({ body, fileName, params: params as DataValidateParams });
  }
}

export type { ProcessorOutput } from './types.js';
