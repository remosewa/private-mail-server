/**
 * dlq-redrive Lambda
 *
 * Manually triggered (e.g. via console or CLI) to redrive messages from the
 * inbound-email-processor DLQ back to the ingest Lambda.
 *
 * Each DLQ message is the original async Lambda invocation record, which
 * contains the S3Event payload. We re-invoke the ingest Lambda synchronously
 * (RequestResponse) so we know if it succeeded before deleting from the DLQ.
 *
 * Returns a summary: { redriven: number, failed: number, errors: string[] }
 */

import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const sqs = new SQSClient({});
const lambdaClient = new LambdaClient({});

const DLQ_URL = process.env.DLQ_URL!;
const TARGET_FUNCTION = process.env.TARGET_FUNCTION_NAME!;
// How many messages to redrive per invocation (SQS returns up to 10 per call, we loop)
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE ?? '100', 10);

export const handler = async (): Promise<{
  redriven: number;
  failed: number;
  errors: string[];
}> => {
  let redriven = 0;
  let failed = 0;
  const errors: string[] = [];
  let totalProcessed = 0;

  // SQS doesn't guarantee returning all messages in one call — loop until
  // the queue returns empty or we hit BATCH_SIZE total.
  while (totalProcessed < BATCH_SIZE) {
    const batchSize = Math.min(BATCH_SIZE - totalProcessed, 10);
    const receiveRes = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: DLQ_URL,
        MaxNumberOfMessages: batchSize,
        WaitTimeSeconds: 1,
        AttributeNames: ['All'],
      }),
    );

    const messages = receiveRes.Messages ?? [];
    if (messages.length === 0) break; // queue is empty

    console.log(`[dlq-redrive] Received ${messages.length} messages (total so far: ${totalProcessed})`);
    totalProcessed += messages.length;

  for (const msg of messages) {
    if (!msg.Body || !msg.ReceiptHandle) continue;

    // The DLQ message body is the Lambda async invocation record.
    // The actual S3Event is nested under the "requestPayload" field.
    let payload: string;
    try {
      const parsed = JSON.parse(msg.Body);
      // Lambda DLQ wraps the original event in requestPayload
      payload = parsed.requestPayload
        ? JSON.stringify(parsed.requestPayload)
        : msg.Body;
    } catch {
      payload = msg.Body;
    }

    console.log(`[dlq-redrive] Redriving message ${msg.MessageId}`);

    try {
      const invokeRes = await lambdaClient.send(
        new InvokeCommand({
          FunctionName: TARGET_FUNCTION,
          InvocationType: 'RequestResponse',
          Payload: Buffer.from(payload),
        }),
      );

      const statusCode = invokeRes.StatusCode ?? 0;
      const functionError = invokeRes.FunctionError;

      if (statusCode === 200 && !functionError) {
        // Success — delete from DLQ
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: DLQ_URL,
            ReceiptHandle: msg.ReceiptHandle,
          }),
        );
        redriven++;
        console.log(`[dlq-redrive] OK message ${msg.MessageId}`);
      } else {
        const responsePayload = invokeRes.Payload
          ? Buffer.from(invokeRes.Payload).toString()
          : '(no payload)';
        const err = `Message ${msg.MessageId} failed: ${functionError} — ${responsePayload}`;
        console.error(`[dlq-redrive] ${err}`);
        errors.push(err);
        failed++;
        // Leave message in DLQ (visibility timeout will expire and it'll reappear)
      }
    } catch (e) {
      const err = `Message ${msg.MessageId} invoke error: ${String(e)}`;
      console.error(`[dlq-redrive] ${err}`);
      errors.push(err);
      failed++;
    }
    }
  } // end while

  const summary = { redriven, failed, errors };
  console.log(`[dlq-redrive] Done:`, summary);
  return summary;
};
