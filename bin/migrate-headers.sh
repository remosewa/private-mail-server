#!/bin/bash
# Invoke the header migration lambda to copy headers from S3 to DynamoDB

set -e

echo "Starting header migration..."
aws lambda invoke \
  --function-name chase-header-migration \
  --invocation-type RequestResponse \
  --log-type Tail \
  --payload '{}' \
  /tmp/migration-response.json

echo ""
echo "Migration complete. Response:"
cat /tmp/migration-response.json | jq .
echo ""
echo "Check CloudWatch logs for details:"
echo "aws logs tail /aws/lambda/chase-header-migration --follow"
