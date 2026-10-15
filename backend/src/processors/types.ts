export interface ProcessorInput<P> {
  /** Raw bytes of the uploaded file, read from S3. */
  body: Uint8Array;
  fileName: string;
  params: P;
}

export interface ProcessorOutputFile {
  name: string;
  contentType: string;
  body: string;
}

export interface ProcessorOutput {
  files: ProcessorOutputFile[];
  /** Small summary stored on the job record and shown in the UI (full results live in S3). */
  summary: Record<string, unknown>;
}
